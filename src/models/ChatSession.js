/**
 * ChatSession model
 *
 * Stores a single conversation thread between an admin/user and their
 * RAG assistant. Each session:
 *  - belongs to one user (userId)
 *  - is scoped to one tenant's knowledge base (tenantId)
 *  - accumulates messages in embedded sub-documents
 *  - gets an AI-generated title/summary/tag when ended
 */
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    role:            { type: String, enum: ['user', 'assistant'], required: true },
    content:         { type: String, required: true },
    knowledgeSource: { type: String, enum: ['store', 'general', null], default: null },
  },
  { timestamps: true, _id: true }
);

const chatSessionSchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: String, required: true, index: true },

    // AI-generated metadata (filled when the session is ended / has enough messages)
    title:    { type: String, default: null },  // e.g. "Return policy & shipping costs"
    summary:  { type: String, default: null },  // 2-line human-readable summary
    topicTag: { type: String, default: null },  // e.g. "pricing", "support", "inventory"

    messages: [messageSchema],

    // Lifecycle flags
    isEnded:         { type: Boolean, default: false },
    insightsGenerated: { type: Boolean, default: false },
    memoryExtracted:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Virtual: message count
chatSessionSchema.virtual('messageCount').get(function () {
  return this.messages.length;
});

module.exports = mongoose.model('ChatSession', chatSessionSchema);
