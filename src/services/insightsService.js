/**
 * Insights Service
 *
 * Two AI-powered background jobs:
 *
 * 1. generateSessionInsights(session)
 *    — Calls Groq to produce an auto-title, 2-line summary, and a topic tag
 *      for a just-ended chat session. These appear in the sessions sidebar.
 *
 * 2. extractMemoryFacts(session, userId)
 *    — Calls Groq to extract structured business facts from the conversation
 *      (e.g. "they sell handmade jewellery targeting women aged 25-40").
 *      Facts are upserted into UserMemory and injected into future sessions.
 *
 * Both use the Groq API (fast, cheap) — they run after the user receives
 * their response so latency is zero from the user's perspective.
 */

const UserMemory   = require('../models/UserMemory');
const KnowledgeGap = require('../models/KnowledgeGap');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const OLLAMA_URL        = process.env.OLLAMA_URL        || 'http://localhost:11434';
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '25000', 10);

// ─── LLM helpers (Groq primary → Ollama offline fallback) ────────────────────
async function callGroq(systemPrompt, userPrompt, maxTokens = 256) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const res = await fetch(GROQ_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens:  maxTokens,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq error (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Ollama fallback for offline environments — uses same chat model as ragService.
 */
async function callOllama(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body: JSON.stringify({
        model:   OLLAMA_CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        stream: false,
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Ollama timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Ollama chat failed (${res.status})`);
  const data = await res.json();
  return data.message?.content || '';
}

/**
 * Try Groq first; fall back to Ollama when offline.
 */
async function callLLM(systemPrompt, userPrompt, maxTokens = 256) {
  try {
    return await callGroq(systemPrompt, userPrompt, maxTokens);
  } catch (groqErr) {
    console.warn(`⚠️  Insights: Groq unavailable (${groqErr.message}) — falling back to Ollama`);
    return await callOllama(systemPrompt, userPrompt);
  }
}

// ─── Conversation transcript helper ──────────────────────────────────────────
function buildTranscript(messages, maxMessages = 30) {
  return messages
    .slice(-maxMessages)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

// ─── 1. Session Insights ──────────────────────────────────────────────────────
/**
 * Generate a title, summary and topic tag for a completed session.
 *
 * @param {object} session - ChatSession mongoose document
 * @returns {{ title: string, summary: string, topicTag: string }}
 */
async function generateSessionInsights(session) {
  const transcript = buildTranscript(session.messages);

  const systemPrompt = `You are a conversation analyst. Given a support/assistant chat transcript, 
extract structured metadata. Always respond ONLY with valid JSON — no markdown, no explanation.`;

  const userPrompt = `Analyse this conversation and return JSON with exactly these fields:
{
  "title": "short descriptive title (max 60 chars, no quotes)",
  "summary": "2-sentence plain-language summary of what was discussed and resolved",
  "topicTag": "single lowercase word or compound (e.g. pricing, returns, inventory, marketing, onboarding, support)"
}

Conversation:
${transcript}`;

  const raw = await callLLM(systemPrompt, userPrompt, 200);

  try {
    // Strip any accidental markdown code fences
    const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
    const parsed  = JSON.parse(cleaned);
    return {
      title:    (parsed.title    || 'Untitled conversation').slice(0, 120),
      summary:  parsed.summary   || '',
      topicTag: (parsed.topicTag || 'general').toLowerCase().replace(/\s+/g, '-').slice(0, 30),
    };
  } catch {
    // Fallback: use first user message as title
    const firstUser = session.messages.find((m) => m.role === 'user');
    return {
      title:    firstUser ? firstUser.content.slice(0, 80) : 'Chat session',
      summary:  '',
      topicTag: 'general',
    };
  }
}

// ─── 2. Memory Fact Extraction ────────────────────────────────────────────────
/**
 * Extract persistent business facts from a conversation and upsert into UserMemory.
 *
 * @param {object} session - ChatSession mongoose document
 * @param {string} userId  - MongoDB ObjectId of the user
 */
async function extractMemoryFacts(session, userId) {
  const transcript  = buildTranscript(session.messages, 40);

  const systemPrompt = `You are an AI that extracts durable business facts from conversations. 
You only extract facts the user explicitly stated about their OWN business. 
Respond ONLY with valid JSON — no markdown, no explanation.`;

  const userPrompt = `Extract concrete business facts from this conversation. 
Return a JSON array of fact objects. Only include facts the USER stated about their business.
If no clear facts were stated, return [].

Each fact object:
{
  "fact": "concise factual statement",
  "category": one of ["business_info","target_audience","products_services","goals","challenges","preferences","other"],
  "confidence": 0.7-1.0
}

Conversation:
${transcript}`;

  const raw  = await callLLM(systemPrompt, userPrompt, 400);

  let facts = [];
  try {
    const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
    const parsed  = JSON.parse(cleaned);
    facts = Array.isArray(parsed) ? parsed : [];
  } catch {
    return; // silent — don't crash if JSON parse fails
  }

  if (facts.length === 0) return;

  const newFacts = facts
    .filter((f) => f.fact && typeof f.fact === 'string')
    .map((f) => ({
      fact:            f.fact.slice(0, 300),
      category:        f.category || 'other',
      confidence:      Math.min(1, Math.max(0, f.confidence || 0.8)),
      sourceSessionId: session._id,
    }));

  // Upsert: create UserMemory doc if first time, then push new facts
  await UserMemory.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: { tenantId: session.tenantId },
      $push:        { facts: { $each: newFacts } },
    },
    { upsert: true }
  );
}

// ─── 3. Knowledge Gap Detection ──────────────────────────────────────────────
/**
 * Called from chat.js after a RAG answer with no knowledge base context.
 * Records the question as a knowledge gap for this tenant.
 *
 * @param {string} question  - the user's question
 * @param {string} tenantId  - store namespace
 * @param {string} sessionId - source session ObjectId
 */
async function recordKnowledgeGap(question, tenantId, sessionId) {
  try {
    // Normalise question: lowercase, trim, max 500 chars
    const normalised = question.toLowerCase().trim().slice(0, 500);

    await KnowledgeGap.findOneAndUpdate(
      { tenantId, question: normalised },
      {
        $inc: { frequency: 1 },
        $set: { lastAsked: new Date(), sessionId },
      },
      { upsert: true }
    );
  } catch (err) {
    // unique index violation or other minor error — don't crash the chat
    if (err.code !== 11000) {
      console.error('⚠️  KnowledgeGap record error:', err.message);
    }
  }
}

module.exports = { generateSessionInsights, extractMemoryFacts, recordKnowledgeGap };
