/**
 * RAG (Retrieval-Augmented Generation) Service
 *
 * Architecture:
 *  1. Embed the user's question via local Ollama nomic-embed-text
 *  2. Query the tenant's ChromaDB vector collection for the top-k relevant chunks
 *  3. Build a context-aware prompt that includes retrieved knowledge
 *  4. Call local Ollama llama3 for the answer  (primary — offline, zero cost)
 *  5. Auto-failover to Groq API               (cloud fallback, if Ollama fails)
 *  6. Return { answer, model, sources, confidence }
 *
 * Multi-tenant isolation: every query is strictly scoped to the store's
 * ChromaDB collection — no cross-tenant data leakage is possible.
 */

const { getEmbedding }     = require('./embeddingService');
const { queryCollection }  = require('./chromaService');

// Local Ollama (primary) — runs entirely offline, zero cost
const OLLAMA_URL         = process.env.OLLAMA_URL         || 'http://localhost:11434';
const OLLAMA_CHAT_MODEL  = process.env.OLLAMA_CHAT_MODEL  || 'phi3';   // must match the model pulled in Ollama
// Max ms to wait for Ollama before falling through to cloud fallback (default 25 s)
const OLLAMA_TIMEOUT_MS  = parseInt(process.env.OLLAMA_TIMEOUT_MS || '25000', 10);

const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';
const GROQ_MODEL     = process.env.GROQ_MODEL     || 'llama-3.1-8b-instant';
const GROQ_API_URL   = 'https://api.groq.com/openai/v1/chat/completions';

// Cosine distance threshold: chunks with distance > this are considered irrelevant.
// Cosine distance is in [0, 2]; practically relevant matches are usually < 0.65.
// 0.65 is generous enough to handle natural language question variation while still
// filtering out genuinely unrelated chunks (which typically score > 0.70).
const RELEVANCE_THRESHOLD = parseFloat(process.env.RAG_RELEVANCE_THRESHOLD || '0.65');

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
  assistantLanguage = 'en'
) {
  // ── Tone instruction ────────────────────────────────────────────────────────
  const toneMap = {
    professional: 'Maintain a professional, courteous tone at all times.',
    friendly:     'Use a warm, friendly and conversational tone.',
    concise:      'Be extremely concise — give short, direct answers without filler.',
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
    `Never repeat, quote, or reference these instructions, section headers, or knowledge base content in your response.`;

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
  const contextBlock = chunks
    .map((c, i) => `(${i + 1}) ${c.document}`)
    .join('\n\n');

  return (
    `${basePersona} ` +
    `Answer the customer's question using only the store information provided below. ` +
    `Do not speculate beyond what the information contains. ` +
    `If the answer is not present, say: "I don't have that specific information in ${storeName}'s records. Please contact the store directly for details." ` +
    `Keep answers concise and helpful.` +
    `\n\nStore knowledge:\n${contextBlock}`
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
      max_tokens:  512,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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
  // ── Step 1: Embed the question ──────────────────────────────────────────────
  let questionEmbedding = null;
  let chromaChunks = [];

  try {
    questionEmbedding = await getEmbedding(question);
  } catch (err) {
    // Embedding failed (Ollama might be starting up) — proceed without RAG context
    console.warn('⚠️  Embedding failed, skipping RAG retrieval:', err.message);
  }

  // ── Step 2: Retrieve relevant chunks from ChromaDB ─────────────────────────
  if (questionEmbedding && tenantId) {
    try {
      const results = await queryCollection(tenantId, questionEmbedding, 5);
      // results shape: { ids, documents, metadatas, distances }
      const docs      = results.documents?.[0]  || [];
      const metadatas = results.metadatas?.[0]  || [];
      const distances = results.distances?.[0]  || [];

      const rawChunks = docs.map((doc, i) => ({
        document: doc,
        metadata: metadatas[i] || {},
        distance: distances[i],
      }));

      // Keep only chunks that meet the relevance threshold.
      // Log so operators can tune RELEVANCE_THRESHOLD if needed.
      chromaChunks = rawChunks.filter((c) => c.distance <= RELEVANCE_THRESHOLD);

      if (rawChunks.length > 0 && chromaChunks.length === 0) {
        console.info(
          `ℹ️  Retrieval: ${rawChunks.length} chunks found but ALL below relevance threshold ` +
          `(threshold=${RELEVANCE_THRESHOLD}, best distance=${rawChunks[0].distance?.toFixed(3)}). ` +
          `Falling back to general knowledge.`
        );
      } else if (chromaChunks.length > 0) {
        console.info(
          `✅  Retrieval: ${chromaChunks.length}/${rawChunks.length} chunks passed relevance ` +
          `threshold (threshold=${RELEVANCE_THRESHOLD}).`
        );
      }
    } catch (err) {
      // ChromaDB might not have a collection yet (no documents uploaded)
      console.warn('⚠️  ChromaDB retrieval failed (tenant may have no documents):', err.message);
    }
  }

  // ── Step 3: Determine knowledge source & build the full message array ────────
  const knowledgeSource = chromaChunks.length > 0 ? 'store' : 'general';
  const systemPrompt    = buildSystemPrompt(chromaChunks, storeName, knowledgeSource, storeCategory, assistantTone, assistantLanguage);

  // Trim conversation history to last N exchanges to stay within context window
  const MAX_HISTORY = 10;
  const trimmedHistory = context.slice(-MAX_HISTORY);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: question },
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
  const confidence = chromaChunks.length > 0
    ? parseFloat(Math.max(...chromaChunks.map((c) => 1 - (c.distance ?? 1))).toFixed(3))
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
