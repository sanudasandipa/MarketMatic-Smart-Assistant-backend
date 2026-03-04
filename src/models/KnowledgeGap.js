/**
 * KnowledgeGap model
 *
 * Tracks questions the assistant couldn't answer from the store's own
 * documents. These are surfaced in the admin's knowledge base panel as
 * suggestions for what content to upload next.
 */
const mongoose = require('mongoose');

const knowledgeGapSchema = new mongoose.Schema(
  {
    tenantId:  { type: String, required: true, index: true },
    question:  { type: String, required: true },
    frequency: { type: Number, default: 1 },
    lastAsked: { type: Date,   default: Date.now },
    resolved:  { type: Boolean, default: false }, // mark resolved after uploading relevant docs
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSession', default: null },
  },
  { timestamps: true }
);

// Compound unique: one gap record per (tenantId + normalised question)
knowledgeGapSchema.index({ tenantId: 1, question: 1 }, { unique: true });

module.exports = mongoose.model('KnowledgeGap', knowledgeGapSchema);
