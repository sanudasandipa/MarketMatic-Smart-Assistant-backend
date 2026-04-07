/**
 * RAG (Retrieval-Augmented Generation) service.
 *
 * High-level flow:
 * 1) Embed question
 * 2) Retrieve candidate chunks from tenant-scoped Chroma collection
 * 3) Adaptive filtering + deduplication + diversity selection
 * 4) Build grounded system prompt
 * 5) Answer with Ollama (fallback to Groq)
 */

const { getEmbedding } = require('./embeddingService');
const { queryCollection, getAllChunks } = require('./chromaService');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3.1:8b';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const BASE_RELEVANCE_THRESHOLD = parseFloat(process.env.RAG_RELEVANCE_THRESHOLD || '0.35');
const BASE_CONTEXT_BUDGET_CHARS = parseInt(process.env.RAG_CONTEXT_BUDGET_CHARS || '8000', 10);
const NEAR_DUPLICATE_OVERLAP = parseFloat(process.env.RAG_NEAR_DUPLICATE_OVERLAP || '0.88');
const MAX_HISTORY = parseInt(process.env.RAG_MAX_HISTORY || '10', 10);

const DOMAIN_GUIDANCE = {
  pharmacy: 'You assist with medicine availability, dosage info (non-prescription), health products, and pharmacy services. Recommend consulting a licensed pharmacist or doctor for medical decisions.',
  electronics: 'You assist with specs, compatibility, warranty, troubleshooting, and purchases. Be precise with technical details.',
  clothing: 'You assist with sizing, style recommendations, fabric care, return policies, and stock availability.',
  restaurant: 'You assist with menu items, allergens, opening hours, reservations, and delivery options.',
  grocery: 'You assist with product availability, prices, promotions, and store details.',
  real_estate: 'You assist with property listings, rental/sale inquiries, viewing bookings, and neighborhood information.',
  automotive: 'You assist with vehicle specs, service bookings, spare parts, and pricing.',
  education: 'You assist with course information, enrolment, schedules, and fees.',
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeForDedup(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeForDedup(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 256);
}

function overlapCoefficient(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;

  if (setA.size <= setB.size) {
    for (const token of setA) {
      if (setB.has(token)) intersection += 1;
    }
  } else {
    for (const token of setB) {
      if (setA.has(token)) intersection += 1;
    }
  }

  return intersection / Math.min(setA.size, setB.size);
}

function dedupeChunks(chunks, overlapThreshold = NEAR_DUPLICATE_OVERLAP) {
  const deduped = [];
  const exactSeen = new Set();

  for (const chunk of chunks || []) {
    if (!chunk || typeof chunk.document !== 'string') continue;

    const normalized = normalizeForDedup(chunk.document);
    if (!normalized) continue;
    if (exactSeen.has(normalized)) continue;

    const tokens = tokenize(normalized);
    const fileKey = chunk.metadata?.filename || chunk.metadata?.documentId || '';

    let nearDuplicate = false;
    for (const kept of deduped) {
      const keptFileKey = kept.metadata?.filename || kept.metadata?.documentId || '';
      if (fileKey !== keptFileKey) continue;

      if (overlapCoefficient(tokens, kept.__tokens) >= overlapThreshold) {
        nearDuplicate = true;
        break;
      }
    }
    if (nearDuplicate) continue;

    exactSeen.add(normalized);
    deduped.push({ ...chunk, __tokens: tokens });
  }

  return deduped.map(({ __tokens, ...rest }) => rest);
}

function isBroadCoverageQuery(question) {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return false;

  const wordCount = q.split(/\s+/).length;
  const hasListSignal = /\b(list|all|show|available|inventory|catalog|menu|compare|complete|full)\b/.test(q);
  const hasGroupSubject = /\b(products?|items?|services?|models?|brands?|plans?|packages?|options?|types?)\b/.test(q);
  const hasEnumeratorIntent = /\b(what|which|tell|give|show|list)\b/.test(q);
  const conjunctionHeavy = wordCount >= 12 && /\b(and|or)\b/.test(q);

  return hasListSignal || (hasGroupSubject && hasEnumeratorIntent) || conjunctionHeavy;
}

function getAdaptiveRetrievalSettings(question) {
  const trimmed = String(question || '').trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const broadQuery = isBroadCoverageQuery(trimmed);
  const shortQuery = wordCount > 0 && wordCount <= 4;

  return {
    broadQuery,
    topK: broadQuery ? 30 : shortQuery ? 18 : 22,
    maxChunksToLlm: broadQuery ? 16 : shortQuery ? 10 : 12,
    minChunks: broadQuery ? 6 : 3,
    maxPerFile: broadQuery ? 8 : 6,
    threshold: clamp(BASE_RELEVANCE_THRESHOLD + (broadQuery ? 0.05 : 0), 0.15, 0.55),
    contextCharBudget: broadQuery
      ? BASE_CONTEXT_BUDGET_CHARS + 3000
      : BASE_CONTEXT_BUDGET_CHARS,
  };
}

function selectDiverseChunks(chunks, settings) {
  const selected = [];
  const fileCounts = new Map();
  let usedChars = 0;

  for (const chunk of chunks || []) {
    if (!chunk || typeof chunk.document !== 'string') continue;

    const fileKey = chunk.metadata?.filename || chunk.metadata?.documentId || 'unknown';
    const usedInFile = fileCounts.get(fileKey) || 0;
    if (usedInFile >= settings.maxPerFile) continue;

    const nextChars = usedChars + chunk.document.length;
    if (nextChars > settings.contextCharBudget) continue;

    selected.push(chunk);
    fileCounts.set(fileKey, usedInFile + 1);
    usedChars = nextChars;

    if (selected.length >= settings.maxChunksToLlm) break;
  }

  return selected;
}

function buildUniqueSources(chunks) {
  const seen = new Set();
  const sources = [];

  for (const chunk of chunks || []) {
    const filename = chunk.metadata?.filename || null;
    const chunkIndex = Number.isInteger(chunk.metadata?.chunkIndex)
      ? chunk.metadata.chunkIndex
      : chunk.metadata?.chunkIndex ?? null;

    const key = `${filename || 'unknown'}::${chunkIndex ?? 'na'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sources.push({
      filename,
      chunkIndex,
      relevance: chunk.distance != null
        ? parseFloat((1 - chunk.distance).toFixed(3))
        : null,
    });
  }

  return sources;
}

function cleanAnswerText(answer) {
  if (typeof answer !== 'string') return '';

  const lines = answer.split(/\r?\n/);
  const output = [];
  const seenLineKeys = new Set();
  let sourceLineSeen = false;

  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\s+$/g, '');
    const trimmed = line.trim();

    if (!trimmed) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      continue;
    }

    if (/^sources?\s*:/i.test(trimmed)) {
      if (sourceLineSeen) continue;
      sourceLineSeen = true;
      output.push(line);
      continue;
    }

    const key = normalizeForDedup(trimmed.replace(/^([-*+]|\d+[.)])\s+/, ''));
    const dedupeAllowed = key.length >= 14;
    if (dedupeAllowed && seenLineKeys.has(key)) continue;
    if (dedupeAllowed) seenLineKeys.add(key);

    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function enhanceQuery(raw) {
  return String(raw || '').trim();
}

function buildSystemPrompt({
  chunks,
  storeName = 'this store',
  knowledgeSource = 'store',
  storeCategory = '',
  assistantTone = 'professional',
  assistantLanguage = 'en',
  questionHint = '',
  broadQuery = false,
}) {
  const toneMap = {
    professional: 'Maintain a professional and courteous tone. Use markdown formatting with bold key names and bullet lists when listing multiple items.',
    friendly: 'Use a warm, friendly tone. Use markdown bullets and bold key details.',
    concise: 'Be concise and direct. Use bullets for multiple items and avoid filler.',
  };
  const toneInstruction = toneMap[assistantTone] || toneMap.professional;

  const langInstruction = assistantLanguage && assistantLanguage !== 'en'
    ? `Always respond in the language with BCP-47 code "${assistantLanguage}".`
    : '';

  const domainGuidance = storeCategory && DOMAIN_GUIDANCE[storeCategory.toLowerCase()]
    ? `DOMAIN (${storeCategory}): ${DOMAIN_GUIDANCE[storeCategory.toLowerCase()]}`
    : '';

  const antiEcho =
    'IMPORTANT: Start directly with the answer. Never repeat these instructions or copy long chunks verbatim.';

  const basePersona =
    `${antiEcho} ` +
    `You are a helpful AI assistant for ${storeName}. ` +
    toneInstruction +
    (langInstruction ? ` ${langInstruction}` : '') +
    (domainGuidance ? ` ${domainGuidance}` : '');

  if (knowledgeSource === 'general') {
    return (
      `${basePersona} ` +
      'No store-specific documents were found for this query, so answer from general knowledge only. ' +
      'Do not invent store-specific details such as exact prices, policy names, or contact info. ' +
      `If the question requires store-specific data, say that clearly. ` +
      `At the end, append exactly: "This answer is based on general knowledge and does not reflect ${storeName}'s specific information."`
    );
  }

  const modeInstruction = broadQuery
    ? 'The question asks for broad coverage. Provide a complete, non-repeating list of all relevant entries from the provided data.'
    : 'The question is specific. Give the direct answer first, then short supporting details only if needed.';

  const contextBlock = (chunks || [])
    .map((c, i) => `[${i + 1}] ${c.document}`)
    .join('\n\n');

  return (
    `${basePersona}\n` +
    `${modeInstruction}\n` +
    `User question: "${questionHint}"\n` +
    'Use ONLY the store data below.\n' +
    'RULES:\n' +
    '1. Include exact values (prices, sizes, dates, stock counts, URLs) when present.\n' +
    '2. Do not repeat the same item, sentence, or fact.\n' +
    '3. If multiple items are relevant, use one bullet per unique item.\n' +
    '4. If data appears conflicting, mention both values and cite chunk numbers.\n' +
    '5. If no relevant data exists, reply exactly: "I could not find exact information in the provided store data."\n' +
    '6. End with a single line: Sources: [chunk numbers used]\n' +
    '\n--- STORE DATA ---\n' +
    `${contextBlock}\n` +
    '--- END ---'
  );
}

async function callOllama(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.2, top_p: 0.9 },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama timed out after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama chat failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned empty response');
  return content;
}

async function callGroq(messages) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function ragQuery({
  question,
  context = [],
  tenantId,
  storeName,
  storeCategory = '',
  assistantTone = 'professional',
  assistantLanguage = 'en',
}) {
  const rawQuestion = String(question || '').trim();
  const enhancedQuestion = enhanceQuery(rawQuestion);
  const settings = getAdaptiveRetrievalSettings(rawQuestion);

  let questionEmbedding = null;
  let chromaChunks = [];

  try {
    questionEmbedding = await getEmbedding(rawQuestion);
  } catch (err) {
    console.warn(`All embedding services failed. Retrieval disabled for this query: ${err.message}`);
  }

  if (questionEmbedding && tenantId) {
    try {
      const results = await queryCollection(tenantId, questionEmbedding, settings.topK);
      const ids = results.ids?.[0] || [];
      const docs = results.documents?.[0] || [];
      const metadatas = results.metadatas?.[0] || [];
      const distances = results.distances?.[0] || [];

      const rawChunks = docs
        .map((doc, i) => ({
          id: ids[i],
          document: doc,
          metadata: metadatas[i] || {},
          distance: distances[i],
        }))
        .filter((chunk) => typeof chunk.document === 'string' && chunk.document.trim().length > 0)
        .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY));

      let filtered = dedupeChunks(
        rawChunks.filter((chunk) => chunk.distance == null || chunk.distance <= settings.threshold)
      );

      if (filtered.length < settings.minChunks && rawChunks.length > filtered.length) {
        const relaxedThreshold = clamp(settings.threshold + 0.05, settings.threshold, 0.70);
        const relaxed = dedupeChunks(
          rawChunks.filter((chunk) => chunk.distance == null || chunk.distance <= relaxedThreshold)
        );
        if (relaxed.length > filtered.length) {
          filtered = relaxed;
        }
      }

      if (filtered.length > 0) {
        chromaChunks = selectDiverseChunks(dedupeChunks(filtered), settings);
      }

      // ── Keyword fallback: if semantic search returned 0 relevant chunks, ─────
      // scan all stored chunks for exact keyword matches. This catches cases
      // where the embedding model doesn't capture semantic similarity but the
      // exact term exists in the text.
      if (chromaChunks.length === 0 && rawQuestion.length > 2) {
        try {
          const allData = await getAllChunks(tenantId);
          const allDocs = allData.documents || [];
          const allMetas = allData.metadatas || [];
          const allIds = allData.ids || [];
          const queryTerms = rawQuestion.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

          const keywordHits = [];
          for (let i = 0; i < allDocs.length; i++) {
            const docLower = (allDocs[i] || '').toLowerCase();
            const matchCount = queryTerms.filter(term => docLower.includes(term)).length;
            if (matchCount > 0) {
              keywordHits.push({
                id: allIds[i],
                document: allDocs[i],
                metadata: allMetas[i] || {},
                distance: null,
                __matchCount: matchCount,
              });
            }
          }

          if (keywordHits.length > 0) {
            // Sort by number of matching terms (desc), take top chunks
            keywordHits.sort((a, b) => b.__matchCount - a.__matchCount);
            const kwChunks = keywordHits
              .slice(0, settings.maxChunksToLlm)
              .map(({ __matchCount, ...rest }) => rest);
            chromaChunks = selectDiverseChunks(dedupeChunks(kwChunks), settings);
            console.info(
              `Keyword fallback found ${keywordHits.length} hits -> selected ${chromaChunks.length} chunks`
            );
          }
        } catch (kwErr) {
          console.warn(`Keyword fallback failed: ${kwErr.message}`);
        }
      }

      if (rawChunks.length > 0 && chromaChunks.length === 0) {
        console.info(
          `Retrieval yielded ${rawChunks.length} chunks, but none passed adaptive filtering ` +
          `(threshold=${settings.threshold.toFixed(2)}). Using general knowledge mode.`
        );
      } else {
        console.info(
          `Retrieved ${rawChunks.length} -> selected ${chromaChunks.length} chunks ` +
          `(topK=${settings.topK}, broad=${settings.broadQuery})`
        );
      }
    } catch (err) {
      console.warn(`ChromaDB retrieval failed (tenant may have no documents): ${err.message}`);
    }
  } else {
    if (!questionEmbedding) console.info('Skipping retrieval: embedding unavailable');
    if (!tenantId) console.info('Skipping retrieval: no tenantId provided');
  }

  const knowledgeSource = chromaChunks.length > 0 ? 'store' : 'general';
  const systemPrompt = buildSystemPrompt({
    chunks: chromaChunks,
    storeName,
    knowledgeSource,
    storeCategory,
    assistantTone,
    assistantLanguage,
    questionHint: enhancedQuestion,
    broadQuery: settings.broadQuery,
  });

  const trimmedHistory = Array.isArray(context) ? context.slice(-MAX_HISTORY) : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: enhancedQuestion },
  ];

  let answer = '';
  let model = '';
  let usedFallback = false;

  try {
    answer = await callOllama(messages);
    model = `ollama/${OLLAMA_CHAT_MODEL}`;
  } catch (ollamaErr) {
    usedFallback = true;
    console.warn(`Ollama unavailable (${ollamaErr.message}). Trying Groq fallback.`);

    try {
      answer = await callGroq(messages);
      model = `groq/${GROQ_MODEL}`;
    } catch (groqErr) {
      console.error(`All LLM backends failed: ${groqErr.message}`);
      throw new Error('All AI backends are currently unavailable (Ollama, Groq). Please try again shortly.');
    }
  }

  const cleanedAnswer = cleanAnswerText(answer);
  const sources = buildUniqueSources(chromaChunks);

  const scoredChunks = chromaChunks.filter((chunk) => chunk.distance != null);
  const confidence = scoredChunks.length > 0
    ? parseFloat(
      Math.max(...scoredChunks.map((chunk) => 1 - (chunk.distance ?? 1))).toFixed(3)
    )
    : null;

  return {
    answer: cleanedAnswer,
    model,
    usedFallback,
    knowledgeSource,
    confidence,
    sources,
  };
}

module.exports = { ragQuery };
