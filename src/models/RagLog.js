/**
 * RagLog model – stores per-query performance metrics for research evaluation.
 *
 * Enables measurement of:
 *  - Retrieval accuracy  (chunksRetrieved, confidence)
 *  - LLM latency         (responseTimeMs)
 *  - Fallback rate       (fallbackTriggered)
 *  - Knowledge coverage  (knowledgeSource: 'store' vs 'general')
 *
 * These are the core research metrics required to evaluate the RAG pipeline.
 */
const mongoose = require('mongoose');

const ragLogSchema = new mongoose.Schema(
  {
    tenantId:          { type: String, required: true, index: true },
    query:             { type: String, required: true },
    chunksRetrieved:   { type: Number, default: 0 },
    knowledgeSource:   { type: String, enum: ['store', 'general'], default: 'general' },
    modelUsed:         { type: String, default: '' },
    responseTimeMs:    { type: Number, default: 0 },
    fallbackTriggered: { type: Boolean, default: false },
    confidence:        { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RagLog', ragLogSchema);
