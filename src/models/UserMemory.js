/**
 * UserMemory model
 *
 * Stores AI-extracted business facts from chat sessions. After a session
 * ends, Groq reads the conversation and extracts structured facts
 * (e.g. "Business sells handmade soap", "Target audience is women 25-45").
 *
 * These facts are injected into every new chat session's system prompt,
 * giving the assistant persistent cross-session context about the business.
 */
const mongoose = require('mongoose');

const factSchema = new mongoose.Schema(
  {
    fact:            { type: String, required: true },
    category:        {
      type: String,
      enum: ['business_info', 'target_audience', 'products_services', 'goals', 'challenges', 'preferences', 'other'],
      default: 'other',
    },
    sourceSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSession', default: null },
    confidence:      { type: Number, default: 0.9 }, // 0-1, set by AI
  },
  { timestamps: true, _id: true }
);

const userMemorySchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    tenantId: { type: String, required: true, index: true },
    facts:    [factSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserMemory', userMemorySchema);
