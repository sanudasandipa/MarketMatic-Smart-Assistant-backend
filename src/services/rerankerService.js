/**
 * Reranker Service — cross-encoder reranking using @xenova/transformers.
 *
 * Uses BAAI/bge-reranker-base (ONNX, ~110 MB) to rerank retrieved chunks
 * by query–document relevance. Cross-encoders are far more accurate than
 * bi-encoder cosine similarity for determining passage relevance.
 *
 * The model is loaded lazily on first use and cached in memory.
 * On a 4-vCPU VM without GPU, reranking 10 chunks takes ~1-3 seconds.
 */

let pipeline = null;
let rerankerPipeline = null;
let _loadingPromise = null;

const RERANKER_MODEL = process.env.RERANKER_MODEL || 'Xenova/bge-reranker-base';
// Minimum reranker score to keep a chunk (cross-encoder logit > 0 = relevant)
const RERANKER_THRESHOLD = parseFloat(process.env.RERANKER_THRESHOLD || '-2.0');

/**
 * Lazily load the reranker model (only once).
 */
async function getReranker() {
  if (rerankerPipeline) return rerankerPipeline;

  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    const startMs = Date.now();
    console.log(`⏳  Loading reranker model: ${RERANKER_MODEL}...`);

    // Dynamic import — @xenova/transformers is ESM-compatible
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');

    const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL);

    console.log(`✅  Reranker loaded in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

    rerankerPipeline = { tokenizer, model };
    return rerankerPipeline;
  })();

  return _loadingPromise;
}

/**
 * Score a single query–document pair using the cross-encoder.
 *
 * @param {object} reranker - { tokenizer, model }
 * @param {string} query
 * @param {string} document
 * @returns {Promise<number>} relevance score (higher = more relevant)
 */
async function scoreOne(reranker, query, document) {
  const { tokenizer, model } = reranker;
  const inputs = await tokenizer([query], { text_pair: [document], padding: true, truncation: true });
  const output = await model(inputs);
  // output.logits is a Tensor with shape [1, 1] — extract the scalar
  return output.logits.data[0];
}

/**
 * Rerank an array of chunks by cross-encoder relevance to the query.
 *
 * @param {string} query - the user's question
 * @param {Array<{document:string, metadata:object, distance:number|null, id:string}>} chunks
 * @param {number} [topN=5] - how many to return after reranking
 * @returns {Promise<Array>} - reranked, top-N chunks with added `rerankerScore`
 */
async function rerank(query, chunks, topN = 5) {
  if (!chunks || chunks.length === 0) return [];

  try {
    const reranker = await getReranker();

    // Score each chunk
    const scored = [];
    for (const chunk of chunks) {
      const score = await scoreOne(reranker, query, chunk.document);
      scored.push({ ...chunk, rerankerScore: score });
    }

    // Sort by reranker score descending (higher = more relevant)
    scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

    // Filter by threshold and take topN
    const filtered = scored
      .filter(c => c.rerankerScore >= RERANKER_THRESHOLD)
      .slice(0, topN);

    console.log(
      `🔄  Reranker: ${chunks.length} → ${filtered.length} chunks ` +
      `(top score: ${scored[0]?.rerankerScore?.toFixed(2)}, ` +
      `cutoff: ${scored[filtered.length - 1]?.rerankerScore?.toFixed(2)})`
    );

    return filtered;
  } catch (err) {
    // If reranker fails, fall back to original order (embedding distance)
    console.warn(`⚠️  Reranker failed (${err.message}) — using embedding order`);
    return chunks.slice(0, topN);
  }
}

/**
 * Warm up the reranker model (call during startup).
 */
async function warmupReranker() {
  try {
    const reranker = await getReranker();
    // Run a tiny inference to ensure model is fully loaded
    await scoreOne(reranker, 'test', 'test document');
    console.log('✅  Reranker warm and ready.');
  } catch (err) {
    console.warn(`⚠️  Reranker warmup failed: ${err.message}`);
  }
}

module.exports = { rerank, warmupReranker };
