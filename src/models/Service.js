/**
 * Service model – represents an AI service instance provisioned by the Superadmin.
 * Each service is pre-linked to an admin email. When that admin signs up,
 * the service is automatically bound to their account.
 */
const mongoose = require('mongoose');

const ServiceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Service name is required'],
      trim: true,
    },
    // The admin email pre-assigned by superadmin
    assignedEmail: {
      type: String,
      required: [true, 'Assigned admin email is required'],
      lowercase: true,
      trim: true,
    },
    // Once the admin signs up this becomes populated
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'suspended'],
      default: 'pending',
    },
    // Store/business information
    storeName: {
      type: String,
      default: '',
    },
    storeCategory: {
      type: String,
      default: '',
    },
    // ── Agentic assistant configuration ──────────────────────────────────────
    // List of tool identifiers the admin has activated for their store.
    // Available tools: 'inventory_check', 'business_hours', 'contact_info',
    //                  'promotions', 'order_status'
    enabledTools: {
      type: [String],
      default: [],
    },
    // Response tone: 'professional' | 'friendly' | 'concise'
    assistantTone: {
      type: String,
      enum: ['professional', 'friendly', 'concise'],
      default: 'professional',
    },
    // BCP-47 language code for default response language (e.g. 'en', 'ar', 'fr')
    assistantLanguage: {
      type: String,
      default: 'en',
    },
    // Unique slug used as the tenant namespace in RAG
    tenantId: {
      type: String,
      unique: true,
      trim: true,
    },
    // Created by superadmin
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Auto-generate tenantId before save if not set
ServiceSchema.pre('save', function (next) {
  if (!this.tenantId) {
    const base = (this.storeName || this.name || 'service')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    this.tenantId = base + '-' + Date.now().toString(36);
  }
  next();
});

module.exports = mongoose.model('Service', ServiceSchema);
