/**
 * Embedding service – text extraction, chunking, and Ollama embedding.
 *
 * Supported file types: PDF, DOCX, TXT
 * Embedding model:      nomic-embed-text (via local Ollama)
 *
 * Ollama must be running: ollama serve
 * Model must be pulled:   ollama pull nomic-embed-text
 */

const OLLAMA_URL        = process.env.OLLAMA_URL        || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

// ─── Chunking config ──────────────────────────────────────────────────────────
const CHUNK_SIZE    = 500;  // characters per chunk
const CHUNK_OVERLAP = 100;  // overlap between consecutive chunks
const MIN_CHUNK_LEN =  30;  // discard chunks shorter than this

/**
 * Split a long string into overlapping chunks for better RAG retrieval.
 */
function chunkText(text) {
  // Normalise whitespace
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const end   = Math.min(start + CHUNK_SIZE, cleaned.length);
    const chunk = cleaned.slice(start, end).trim();
    if (chunk.length >= MIN_CHUNK_LEN) {
      chunks.push(chunk);
    }
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
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
    const pdfParseModule = require('pdf-parse');
    // pdf-parse may export via .default when resolved as an ESM-wrapped CJS module
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const data = await pdfParse(buffer);
    return data.text;
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
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function getEmbedding(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embedding failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.embedding;
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
