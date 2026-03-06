const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false, // never returned in queries unless explicitly requested
    },
    full_name: {
      type: String,
      trim: true,
      default: '',
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'superadmin'],
      default: 'admin', // direct signup is always admin in this system
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    is_verified: {
      type: Boolean,
      default: false,
    },
    // Linked service (set by superadmin provisioning)
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      default: null,
    },
    // The unique RAG namespace for this admin's store (copy of Service.tenantId)
    // Stored here so every request has it without an extra DB lookup
    tenantId: {
      type: String,
      default: '',
    },
    storeName: {
      type: String,
      default: '',
    },
    // For role:'user' (customer) accounts — links them to the store they belong to.
    // Populated during customer self-registration via POST /api/auth/register/customer.
    // Left empty for admin / superadmin accounts (they use tenantId from their Service).
    customerTenantId: {
      type: String,
      default: '',
      index: true,
    },
  },
  { timestamps: true }
);

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Return a clean object (strip sensitive fields, add virtual id)
UserSchema.methods.toSafeObject = function () {
  return {
    id: this._id.toString(),
    email: this.email,
    username: this.username,
    full_name: this.full_name,
    role: this.role,
    is_active: this.is_active,
    is_verified: this.is_verified,
    serviceId: this.serviceId,
    tenantId: this.tenantId,
    storeName: this.storeName,
    customerTenantId: this.customerTenantId,
    created_at: this.createdAt,
  };
};

module.exports = mongoose.model('User', UserSchema);
