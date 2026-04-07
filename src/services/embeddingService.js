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
const CHUNK_SIZE    = 1200; // characters per chunk — larger keeps full sections intact
const CHUNK_OVERLAP = 300;  // overlap between consecutive chunks to bridge boundary context
const MIN_CHUNK_LEN =  30;  // discard chunks shorter than this

/**
 * Detect section/category headers in text.
 * Matches lines like "CATEGORY 1: RICE & GRAINS", "## Section Title", 
 * or standalone ALL-CAPS titles with 2+ words (not product lines starting with -).
 */
function isSectionHeader(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 4) return false;

  // Product list items are never headers
  if (trimmed.startsWith('-')) return false;

  // Markdown headers
  if (/^#{1,4}\s+\S/.test(trimmed)) return true;

  // Explicit CATEGORY N: ... pattern
  if (/^CATEGORY\s+\d+\s*:/i.test(trimmed)) return true;

  // Standalone ALL-CAPS title lines (at least 2 words, all uppercase letters/symbols, no lowercase)
  // Must not contain product-like patterns (prices, sizes like "1kg", "500g", "—")
  if (/^[A-Z][A-Z0-9 &/,():\-]{4,}$/.test(trimmed) 
      && !trimmed.includes('—')
      && !/\d+(kg|g|ml|l)\b/i.test(trimmed)
      && trimmed.split(/\s+/).length >= 2) {
    return true;
  }

  return false;
}

/**
 * Check if a line is a purely decorative divider (=== or ---) with no real content.
 */
function isDividerLine(line) {
  const trimmed = line.trim();
  return /^[-=]{3,}$/.test(trimmed);
}

/**
 * Split text into section-aware overlapping chunks for better RAG retrieval.
 *
 * Strategy:
 * 1. Parse text into logical sections (header + body lines).
 * 2. Merge sections into chunks up to CHUNK_SIZE.
 * 3. Prepend the most recent section header to each chunk so embeddings
 *    capture the category context (e.g. "SPICES & CURRY POWDERS: Ceylon Cinnamon...").
 * 4. Apply sliding-window overlap to bridge boundary context.
 *
 * This avoids splitting mid-section (e.g. product lists, opening hours,
 * pricing tables) which confuses smaller LLMs.
 */
function chunkText(text) {
  const lines = text.split(/\r?\n/);

  // ── Phase 1: Parse into sections ──────────────────────────────────────────
  // Each section = { header: string|null, body: string }
  const sections = [];
  let currentHeader = null;
  let bodyLines = [];

  for (const line of lines) {
    if (isDividerLine(line)) continue; // skip decorative dividers entirely

    if (isSectionHeader(line)) {
      // Flush previous section
      const bodyText = bodyLines.map(l => l.trim()).filter(l => l.length > 0).join('\n');
      if (bodyText.length >= MIN_CHUNK_LEN) {
        sections.push({ header: currentHeader, body: bodyText });
      }
      currentHeader = line.trim();
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }
  // Flush last section
  const lastBody = bodyLines.map(l => l.trim()).filter(l => l.length > 0).join('\n');
  if (lastBody.length >= MIN_CHUNK_LEN) {
    sections.push({ header: currentHeader, body: lastBody });
  }

  // If section parsing produced nothing, fall back to cleaned full text
  if (sections.length === 0) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < MIN_CHUNK_LEN) return [];
    sections.push({ header: null, body: cleaned });
  }

  // ── Phase 2: Merge sections into chunks ────────────────────────────────────
  const chunks = [];
  let current = '';
  let activeHeader = null;

  for (const section of sections) {
    // Build the section text with header prepended
    const sectionText = section.header
      ? `${section.header}\n${section.body}`
      : section.body;

    if (current.length > 0 && current.length + sectionText.length + 2 > CHUNK_SIZE) {
      // Flush current chunk
      chunks.push(current.trim());
      // Start new chunk: prepend the active header for context continuity
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP);
      const overlap = current.slice(overlapStart).trim();
      current = activeHeader ? `${activeHeader}\n${overlap}` : overlap;
    }

    if (section.header) activeHeader = section.header;
    current += (current.length > 0 ? '\n' : '') + sectionText;
  }

  // Flush remaining text
  if (current.trim().length >= MIN_CHUNK_LEN) {
    chunks.push(current.trim());
  }

  // ── Phase 3: Safety split for oversized chunks ─────────────────────────────
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= CHUNK_SIZE) {
      final.push(chunk);
    } else {
      let start = 0;
      while (start < chunk.length) {
        const end = Math.min(start + CHUNK_SIZE, chunk.length);
        let sub = chunk.slice(start, end).trim();
        // Prepend active header if this sub-chunk doesn't start with one
        if (start > 0 && activeHeader && !isSectionHeader(sub.split('\n')[0])) {
          sub = `${activeHeader}\n${sub}`;
        }
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
