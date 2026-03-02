/**
 * ChromaDB service – manages tenant-isolated vector collections.
 *
 * Each admin store gets its own ChromaDB collection named after its tenantId.
 * This enforces the multi-tenant isolation: no store can ever read another
 * store's vectors because all queries are scoped to one collection.
 *
 * Chroma must be running locally:
 *   chroma run --path ./chroma_data --port 8001
 */
const { ChromaClient } = require('chromadb');

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8001';

// Suppress the noisy ChromaDB warning about missing embedding function config.
// We always supply embeddings explicitly (via Ollama), so this warning is safe to ignore.
const _originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('No embedding function configuration found')
  ) {
    return; // swallow this specific chromadb client warning
  }
  _originalWarn(...args);
};

let _client = null;

// chromadb v3 requires an embeddingFunction at collection creation time even
// when embeddings are passed explicitly during upsert. We provide a no-op here
// so the client doesn't try to instantiate DefaultEmbeddingFunction (which
// requires the optional @chroma-core/default-embed package).
const noopEmbeddingFunction = {
  generate: async (_texts) => {
    throw new Error(
      'noopEmbeddingFunction.generate() called — you must supply embeddings explicitly when calling upsert()'
    );
  },
};

function getClient() {
  if (!_client) {
    // ChromaDB v3+ deprecated the 'path' option in favour of host/port/ssl
    const url  = new URL(CHROMA_URL);
    const ssl  = url.protocol === 'https:';
    const host = url.hostname;
    const port = parseInt(url.port || (ssl ? '443' : '8000'), 10);
    _client = new ChromaClient({ host, port, ssl });
  }
  return _client;
}

/**
 * Get (or create) the collection for a given tenant.
 * cosine distance is best for semantic text similarity.
 */
async function getOrCreateCollection(tenantId) {
  const client = getClient();
  return client.getOrCreateCollection({
    name: tenantId,
    metadata: { 'hnsw:space': 'cosine' },
    embeddingFunction: noopEmbeddingFunction,
  });
}

/**
 * Upsert text chunks + their embeddings into the tenant's collection.
 * Returns the array of ChromaDB IDs that were written.
 *
 * @param {string}   tenantId   - store namespace
 * @param {string[]} chunks     - text fragments
 * @param {number[][]} embeddings - one vector per chunk
 * @param {string}   documentId - MongoDB _id of the Document record
 * @param {string}   filename   - original file name (stored as metadata)
 */
async function upsertChunks(tenantId, chunks, embeddings, documentId, filename) {
  const collection = await getOrCreateCollection(tenantId);

  const ids = chunks.map((_, i) => `${documentId}-chunk-${i}`);

  await collection.upsert({
    ids,
    embeddings,
    documents: chunks,
    metadatas: chunks.map((_, i) => ({
      documentId,
      filename,
      chunkIndex: i,
    })),
  });

  return ids;
}

/**
 * Delete all chunks belonging to a document from the tenant's collection.
 *
 * @param {string}   tenantId  - store namespace
 * @param {string[]} chromaIds - IDs returned by upsertChunks
 */
async function deleteDocumentChunks(tenantId, chromaIds) {
  if (!chromaIds || chromaIds.length === 0) return;
  const collection = await getOrCreateCollection(tenantId);
  await collection.delete({ ids: chromaIds });
}

/**
 * Query the tenant's collection for the most relevant chunks.
 * Used later by the RAG query engine.
 *
 * @param {string}   tenantId    - store namespace
 * @param {number[]} queryVector - embedding of the user's question
 * @param {number}   nResults    - number of chunks to retrieve (default 5)
 */
async function queryCollection(tenantId, queryVector, nResults = 5) {
  const collection = await getOrCreateCollection(tenantId);
  return collection.query({
    queryEmbeddings: [queryVector],
    nResults,
    include: ['documents', 'metadatas', 'distances'],
  });
}

module.exports = { getOrCreateCollection, upsertChunks, deleteDocumentChunks, queryCollection };
