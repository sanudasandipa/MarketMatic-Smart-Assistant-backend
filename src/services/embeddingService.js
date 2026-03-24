/**
 * Embedding service – text extraction, chunking, and Ollama embedding.
 *
 * Supported file types: PDF, DOCX, TXT
 * Embedding model:      nomic-embed-text (via Ollama) — 768-dim
 *
 * Ollama must be running: ollama serve
 * Model must be pulled:   ollama pull nomic-embed-text
 */

// URL for embedding requests — can be separate from chat OLLAMA_URL
const OLLAMA_EMBED_URL   = process.env.OLLAMA_EMBED_URL   || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

// Remote embedding fallback — any OpenAI-compatible /v1/embeddings endpoint.
// E.g. a second Ollama on a VPS, or a self-hosted FastEmbed server.
// Set REMOTE_EMBED_URL and REMOTE_EMBED_MODEL in .env to enable.
const REMOTE_EMBED_URL   = process.env.REMOTE_EMBED_URL   || '';
const REMOTE_EMBED_MODEL = process.env.REMOTE_EMBED_MODEL || 'nomic-embed-text';
const REMOTE_EMBED_KEY   = process.env.REMOTE_EMBED_KEY   || '';

// ─── Chunking config ──────────────────────────────────────────────────────────
const CHUNK_SIZE    = 800;  // characters per chunk — larger keeps Q&A pairs intact
const CHUNK_OVERLAP = 200;  // overlap between consecutive chunks to bridge boundary context
const MIN_CHUNK_LEN =  30;  // discard chunks shorter than this

/**
 * Split text into paragraph-aware overlapping chunks for better RAG retrieval.
 *
 * Strategy: split into paragraphs first, then merge paragraphs into chunks
 * up to CHUNK_SIZE. This avoids splitting mid-section (e.g. opening hours,
 * pricing tables) which confuses smaller LLMs.
 */
function chunkText(text) {
  // Split into paragraphs on double-newlines or section dividers (=== / ---)
  const paragraphs = text
    .split(/\n{2,}|(?=={3,})|(?=-{3,})/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length >= MIN_CHUNK_LEN);

  // If paragraph splitting produced nothing useful, fall back to cleaned text
  if (paragraphs.length === 0) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < MIN_CHUNK_LEN) return [];
    paragraphs.push(cleaned);
  }

  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    // If adding this paragraph exceeds chunk size, flush current chunk
    if (current.length > 0 && current.length + para.length + 1 > CHUNK_SIZE) {
      chunks.push(current.trim());
      // Keep overlap from the end of the current chunk
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP);
      current = current.slice(overlapStart).trim();
    }
    current += (current.length > 0 ? ' ' : '') + para;
  }

  // Flush remaining text
  if (current.trim().length >= MIN_CHUNK_LEN) {
    chunks.push(current.trim());
  }

  // Safety: if a single paragraph is larger than CHUNK_SIZE, split it with sliding window
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= CHUNK_SIZE) {
      final.push(chunk);
    } else {
      let start = 0;
      while (start < chunk.length) {
        const end = Math.min(start + CHUNK_SIZE, chunk.length);
        const sub = chunk.slice(start, end).trim();
        if (sub.length >= MIN_CHUNK_LEN) final.push(sub);
        start += CHUNK_SIZE - CHUNK_OVERLAP;
      }
    }
  }

  return final;
}

/**
 * Extract plain text from a file buffer.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<string>}
 */
async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    // pdf-parse v2 uses a class-based API: new PDFParse({ data: buffer }).getText()
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }

  if (
    mimetype ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // TXT — plain UTF-8
  return buffer.toString('utf-8');
}

/**
 * Generate a single embedding vector using the local Ollama model.
 * Falls back to a configured remote embedding endpoint if Ollama is unavailable.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function getEmbedding(text) {
  // ── Primary: local Ollama ─────────────────────────────────────────────────
  try {
    return await _ollamaEmbed(text);
  } catch (ollamaErr) {
    if (REMOTE_EMBED_URL) {
      console.warn(`⚠️  Ollama embedding failed (${ollamaErr.message}) — trying remote fallback`);
      return await _remoteEmbed(text);
    }
    throw ollamaErr;  // re-throw; caller handles gracefully
  }
}

/**
 * Ollama embedding (primary — offline, zero cost).
 */
async function _ollamaEmbed(text) {
  const EMBED_TIMEOUT_MS = parseInt(process.env.EMBED_TIMEOUT_MS || '120000', 10); // default 120s — allows for Modal cold start
  // Try the modern /api/embed endpoint first (Ollama 0.1.26+)
  // Falls back to the legacy /api/embeddings endpoint automatically.
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), EMBED_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OLLAMA_EMBED_URL}/api/embed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
      signal:  ctrl1.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Ollama embed timed out after ${EMBED_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(t1);
  }

  if (res.status === 404) {
    // Older Ollama — fall back to legacy endpoint
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), EMBED_TIMEOUT_MS);
    try {
      res = await fetch(`${OLLAMA_EMBED_URL}/api/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
        signal:  ctrl2.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Ollama embed timed out after ${EMBED_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(t2);
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embedding failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  // /api/embed returns { embeddings: [[...]] }, legacy returns { embedding: [...] }
  return data.embeddings ? data.embeddings[0] : data.embedding;
}

/**
 * Remote OpenAI-compatible embedding fallback.
 * Activated when REMOTE_EMBED_URL is set and Ollama is unreachable.
 */
async function _remoteEmbed(text) {
  const headers = { 'Content-Type': 'application/json' };
  if (REMOTE_EMBED_KEY) headers['Authorization'] = `Bearer ${REMOTE_EMBED_KEY}`;

  const res = await fetch(`${REMOTE_EMBED_URL}/v1/embeddings`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ model: REMOTE_EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Remote embedding fallback failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const vector = data.data?.[0]?.embedding;
  if (!vector) throw new Error('Remote embedding returned no vector');
  console.log(`✅  Embedding via remote fallback (${REMOTE_EMBED_URL})`);
  return vector;
}

/**
 * Generate embeddings for all chunks sequentially.
 * Sequential (not parallel) to avoid overwhelming the local Ollama process.
 *
 * @param {string[]} chunks
 * @returns {Promise<number[][]>}
 */
async function embedChunks(chunks) {
  const embeddings = [];
  for (const chunk of chunks) {
    embeddings.push(await getEmbedding(chunk));
  }
  return embeddings;
}

module.exports = { chunkText, extractText, embedChunks, getEmbedding };
