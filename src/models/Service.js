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
