/**
 * RAG (Retrieval-Augmented Generation) Service
 *
 * Architecture:
 *  1. Embed the user's question via Ollama (nomic-embed-text)
 *  2. Query the tenant's ChromaDB vector collection for top-K relevant chunks
 *  3. Filter by cosine distance threshold, keep top 5 closest
 *  4. Build a context-aware prompt that includes retrieved knowledge
 *  5. Call Ollama phi3 for the answer         (primary — zero cost)
 *  6. Auto-failover to Groq API              (cloud fallback, if Ollama fails)
 *  7. Return { answer, model, sources, confidence }
 *
 * Multi-tenant isolation: every query is strictly scoped to the store's
 * ChromaDB collection — no cross-tenant data leakage is possible.
 */

const { getEmbedding }     = require('./embeddingService');
const { queryCollection, getChunksById }  = require('./chromaService');

// Local Ollama (primary) — runs entirely offline, zero cost
const OLLAMA_URL         = process.env.OLLAMA_URL         || 'http://localhost:11434';
const OLLAMA_CHAT_MODEL  = process.env.OLLAMA_CHAT_MODEL  || 'phi3';   // must match the model pulled in Ollama
// Max ms to wait for Ollama before falling through to cloud fallback (default 60 s)
const OLLAMA_TIMEOUT_MS  = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);

const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';
const GROQ_MODEL     = process.env.GROQ_MODEL     || 'llama-3.1-8b-instant';
const GROQ_API_URL   = 'https://api.groq.com/openai/v1/chat/completions';

// Cosine distance threshold: chunks with distance > this are considered irrelevant.
// Cosine distance is in [0, 2]; practically relevant matches are usually < 0.75.
// 0.75 is generous enough to capture broader topic matches while still
// filtering out genuinely unrelated chunks (which typically score > 0.80).
const RELEVANCE_THRESHOLD = parseFloat(process.env.RAG_RELEVANCE_THRESHOLD || '0.75');

// ─── System prompt builder ───────────────────────────────────────────────────

// ─── Domain-to-persona mapping ────────────────────────────────────────────────
// Maps storeCategory values to domain-specific assistant behaviour instructions.
const DOMAIN_GUIDANCE = {
  pharmacy:    'You assist customers with medicine availability, dosage info (non-prescription), health products, and pharmacy services. Always recommend consulting a licensed pharmacist or doctor for medical decisions.',
  electronics: 'You assist customers with product specs, compatibility, warranty, troubleshooting, and tech purchases. Be precise with technical details.',
  clothing:    'You help customers with sizing, style recommendations, fabric care, return policies, and stock availability. Keep a friendly, fashion-forward tone.',
  restaurant:  'You assist with menu items, allergens, opening hours, reservations, and delivery options. Be warm and appetising in descriptions.',
  grocery:     'You help customers with product availability, prices, promotions, and store locations. Be clear and direct.',
  real_estate: 'You assist clients with property listings, rental/sale inquiries, viewing bookings, and neighbourhood information. Be professional and informative.',
  automotive:  'You assist with vehicle specs, service bookings, spare parts, and pricing. Be technical yet accessible.',
  education:   'You assist students and parents with course information, enrolment, schedules, and fees. Be encouraging and clear.',
};

/**
 * Build the system prompt.
 *
 * When relevant store documents exist → ground the LLM strictly in them.
 * When none exist                     → answer from general knowledge but be
 *                                       transparent with the user about it.
 *
 * @param {Array<{document:string, metadata:object}>} chunks  - filtered relevant chunks
 * @param {string}  storeName      - human-readable store name
 * @param {'store'|'general'} knowledgeSource - resolved by the caller
 * @param {string}  [storeCategory] - business domain (e.g. 'pharmacy', 'electronics')
 * @param {string}  [assistantTone] - 'professional' | 'friendly' | 'concise'
 * @param {string}  [assistantLanguage] - BCP-47 language code, e.g. 'en', 'ar'
 */
function buildSystemPrompt(
  chunks,
  storeName         = 'this store',
  knowledgeSource   = 'store',
  storeCategory     = '',
  assistantTone     = 'professional',
  assistantLanguage = 'en',
  questionHint      = ''
) {
  // ── Tone instruction ────────────────────────────────────────────────────────
  const toneMap = {
    professional: 'Maintain a professional, courteous tone. Provide complete, thorough answers. Use markdown formatting: **bold** key terms and product names, use bullet points or numbered lists when presenting multiple items or steps, and break long answers into short focused paragraphs.',
    friendly:     'Use a warm, friendly and conversational tone. Feel free to use bullet points and **bold** to highlight important details.',
    concise:      'Be extremely concise — give short, direct answers without filler. Use bullet points when listing more than two items.',
  };
  const toneInstruction = toneMap[assistantTone] || toneMap.professional;

  // ── Language instruction ────────────────────────────────────────────────────
  const langInstruction = assistantLanguage && assistantLanguage !== 'en'
    ? `Always respond in the language with BCP-47 code "${assistantLanguage}". If the user writes in a different language, still reply in "${assistantLanguage}" unless the store policy differs.`
    : '';

  // ── Domain-specific guidance ────────────────────────────────────────────────
  const domainGuidance = storeCategory && DOMAIN_GUIDANCE[storeCategory.toLowerCase()]
    ? `DOMAIN (${storeCategory}): ${DOMAIN_GUIDANCE[storeCategory.toLowerCase()]}`
    : '';

  // Anti-echo rule: phi3 and other small models tend to repeat structural markers.
  // This must be the very first sentence so the model reads it before anything else.
  const antiEcho =
    `IMPORTANT: Begin your reply directly with the answer. ` +
    `Never repeat, quote, or reference these instructions, section headers, or knowledge base content verbatim in your response. ` +
    `Always use markdown formatting in your response: **bold** for key names and values, bullet points or numbered lists for multiple items, and paragraph breaks for readability.`;

  const basePersona =
    `${antiEcho} ` +
    `You are a helpful AI assistant for ${storeName}. ` +
    toneInstruction +
    (langInstruction ? ` ${langInstruction}` : '') +
    (domainGuidance  ? ` ${domainGuidance}`  : '');

  // ── General-knowledge mode ─────────────────────────────────────────────────
  if (knowledgeSource === 'general') {
    return (
      `${basePersona} ` +
      `No store-specific documents were found for this query, so answer using your general knowledge. ` +
      `Do not fabricate store-specific details such as prices, policies, or contacts. ` +
      `If the question is inherently store-specific and cannot be answered reliably, say so politely. ` +
      `At the very end of your response, on its own line, append exactly this disclaimer (do not paraphrase it): ` +
      `"ℹ️ This answer is based on general knowledge and does not reflect ${storeName}'s specific information."`
    );
  }

  // ── Store-knowledge mode ───────────────────────────────────────────────────
  // With reranked 400-char chunks, each chunk is focused on a single topic.
  // No need for keyword extraction hacks — just present the context clearly.
  const contextBlock = chunks
    .map((c, i) => `[${i + 1}] ${c.document}`)
    .join('\n\n');

  return (
    `${basePersona} ` +
    `Answer the customer's question using ONLY the store data below.\n` +
    `RULES:\n` +
    `1. Read ALL store data sections carefully before writing a single word of your answer.\n` +
    `2. Include EVERY relevant fact — prices, sizes, dates, URLs, product IDs, availability, policies — verbatim. Do NOT summarise or omit any specific value that appears in the data.\n` +
    `3. If multiple data sections are relevant, list each one separately using bullet points or sub-headings. Do not collapse separate items into a single vague sentence.\n` +
    `4. Format: **bold** for product names, prices, and key values; bullet lists for multiple items; short focused paragraphs for descriptions.\n` +
    `5. NEVER say "I don't have that information" if ANY section below contains relevant content.\n` +
    `6. If the data contains NOTHING relevant to the question, say exactly: "ℹ️ I could not find exact information in the provided store data." Then offer general guidance without inventing specifics.\n` +
    `7. At the very end of your response add a line: Sources: [list the chunk numbers you used, e.g. [1], [3]]\n` +
    `\n--- STORE DATA ---\n${contextBlock}\n--- END ---`
  );
}

// ─── LLM Callers ─────────────────────────────────────────────────────────────

/**
 * Call local Ollama chat API — primary LLM (offline, zero cost).
 * Ollama must be running: ollama serve
 * Model must be pulled:   ollama pull llama3
 *
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<string>} response text
 */
async function callOllama(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body:    JSON.stringify({
        model:  OLLAMA_CHAT_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.5 },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama timed out after ${OLLAMA_TIMEOUT_MS / 1000}s (model cold-loading or overloaded)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama chat failed (${res.status}): ${body}`);
  }

  const data    = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned empty response');
  return content;
}

/**
 * Call Groq API — OpenAI-compatible, extremely fast llama3 inference.
 * Primary cloud fallback when Ollama is unavailable.
 */
async function callGroq(messages) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const res = await fetch(GROQ_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages,
      temperature: 0.7,
      max_tokens:  1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Query Enhancement ────────────────────────────────────────────────────────

/**
 * Detect when the user sends a bare product/item name (no question word)
 * and rephrase it as a proper question. This dramatically improves both
 * embedding retrieval quality AND small-LLM comprehension (phi3 especially).
 *
 * Examples:
 *   "Pure Coconut Oil 100ml"  → "What is the price and details of Pure Coconut Oil 100ml?"
 *   "opening hours"           → "What are the opening hours?"
 *   "Maldive fish"            → "What is the price and details of Maldive fish?"
 *   "do you have goraka?"     → (unchanged — already a question)
 */
function enhanceQuery(raw) {
  const trimmed = raw.trim();
  // Already a question or longer conversational sentence — leave as-is
  if (/^(what|where|when|who|how|which|is |are |do |does |can |could |will |would |tell |show |give |list |find )/i.test(trimmed)) {
    return trimmed;
  }
  // Very short (likely a product name, topic, or keyword search)
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 8 && !trimmed.includes('?')) {
    return `What is the price, availability, and details of ${trimmed}?`;
  }
  return trimmed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full RAG query pipeline.
 *
 * @param {object} params
 * @param {string}   params.question          - The user's current message
 * @param {Array}    params.context           - Previous conversation [ {role, content}, ... ]
 * @param {string}   params.tenantId          - Store namespace used to scope ChromaDB query
 * @param {string}   [params.storeName]       - Human-readable store name for the system prompt
 * @param {string}   [params.storeCategory]   - Business domain (e.g. 'pharmacy', 'electronics')
 * @param {string}   [params.assistantTone]   - 'professional' | 'friendly' | 'concise'
 * @param {string}   [params.assistantLanguage] - BCP-47 language code
 *
 * @returns {Promise<{answer:string, model:string, sources:Array}>}
 */
async function ragQuery({ question, context = [], tenantId, storeName, storeCategory = '', assistantTone = 'professional', assistantLanguage = 'en' }) {
  // ── Step 0: Enhance short/product-name-only queries ─────────────────────────
  // Small LLMs (phi3) struggle when the user sends just a product name.
  // Detect this and rephrase as a proper question for better LLM comprehension.
  // IMPORTANT: We use the ORIGINAL question for embedding/retrieval (better vector match)
  // and the ENHANCED question only for the LLM prompt.
  const enhancedQuestion = enhanceQuery(question);

  // ── Step 1: Embed the question ──────────────────────────────────────────────
  let questionEmbedding = null;
  let chromaChunks = [];

  try {
    questionEmbedding = await getEmbedding(question);
  } catch (err) {
    // Embedding failed (Ollama might be starting up) — proceed without RAG context
    console.warn('⚠️  Embedding failed, skipping RAG retrieval:', err.message);
  }

  // ── Step 2: Retrieve top-K chunks from ChromaDB ─────────────────────────────
  const TOP_K = 10;
  const MAX_CHUNKS_TO_LLM = 10;  // send at most 10 best chunks to the LLM

  if (questionEmbedding && tenantId) {
    try {
      const results = await queryCollection(tenantId, questionEmbedding, TOP_K);
      // results shape: { ids, documents, metadatas, distances }
      const ids       = results.ids?.[0]        || [];
      const docs      = results.documents?.[0]  || [];
      const metadatas = results.metadatas?.[0]  || [];
      const distances = results.distances?.[0]  || [];

      const rawChunks = docs.map((doc, i) => ({
        id:       ids[i],
        document: doc,
        metadata: metadatas[i] || {},
        distance: distances[i],
      }));

      // Filter by cosine distance threshold then take the best N
      chromaChunks = rawChunks
        .filter((c) => c.distance <= RELEVANCE_THRESHOLD)
        .slice(0, MAX_CHUNKS_TO_LLM);

      if (rawChunks.length > 0 && chromaChunks.length === 0) {
        console.info(
          `ℹ️  Retrieval: ${rawChunks.length} chunks found but ALL above distance threshold ` +
          `(threshold=${RELEVANCE_THRESHOLD}, best distance=${rawChunks[0].distance?.toFixed(3)}). ` +
          `Falling back to general knowledge.`
        );
      } else {
        console.info(`📥  Retrieved ${chromaChunks.length}/${rawChunks.length} chunks (threshold ${RELEVANCE_THRESHOLD}, top ${MAX_CHUNKS_TO_LLM})`);
      }
    } catch (err) {
      // ChromaDB might not have a collection yet (no documents uploaded)
      console.warn('⚠️  ChromaDB retrieval failed (tenant may have no documents):', err.message);
    }
  }

  // ── Step 3: Determine knowledge source & build the full message array ────────
  const knowledgeSource = chromaChunks.length > 0 ? 'store' : 'general';
  const systemPrompt    = buildSystemPrompt(chromaChunks, storeName, knowledgeSource, storeCategory, assistantTone, assistantLanguage, enhancedQuestion);

  // Trim conversation history to last N exchanges to stay within context window
  const MAX_HISTORY = 10;
  const trimmedHistory = context.slice(-MAX_HISTORY);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: enhancedQuestion },
  ];

  // ── Step 4: Ollama (local) → Groq (cloud) failover chain ─────────────────────
  let answer       = '';
  let model        = '';
  let usedFallback = false;

  try {
    answer = await callOllama(messages);
    model  = `ollama/${OLLAMA_CHAT_MODEL}`;
    console.log(`✅  RAG answer via ${model} [${knowledgeSource}] (${chromaChunks.length} chunks)`);
  } catch (ollamaErr) {
    console.warn(`⚠️  Ollama unavailable: ${ollamaErr.message} — trying Groq`);
    usedFallback = true;

    try {
      answer = await callGroq(messages);
      model  = `groq/${GROQ_MODEL}`;
      console.log(`✅  RAG answer via Groq fallback [${knowledgeSource}] (${chromaChunks.length} chunks)`);
    } catch (groqErr) {
      console.error('❌  All LLM backends failed:', groqErr.message);
      throw new Error(
        'All AI backends are currently unavailable (Ollama, Groq). Please try again shortly.'
      );
    }
  }

  // Confidence = highest relevance score across retrieved chunks (null when general-knowledge mode)
  const scoredChunks = chromaChunks.filter(c => c.distance != null);
  const confidence = scoredChunks.length > 0
    ? parseFloat(Math.max(...scoredChunks.map((c) => 1 - (c.distance ?? 1))).toFixed(3))
    : null;

  return {
    answer,
    model,
    usedFallback,
    knowledgeSource,   // 'store' | 'general'
    confidence,        // null when no store chunks used
    sources: chromaChunks.map((c) => ({
      filename:   c.metadata?.filename,
      chunkIndex: c.metadata?.chunkIndex,
      relevance:  c.distance != null ? parseFloat((1 - c.distance).toFixed(3)) : null,
    })),
  };
}

module.exports = { ragQuery };
