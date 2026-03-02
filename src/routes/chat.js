/**
 * Chat Routes – RAG-powered Smart Assistant endpoints
 *
 * POST /api/admin/chat  — Authenticated endpoint for admin/user testing.
 *                         Tenant is identified automatically from JWT.
 *
 * POST /api/chat        — Public endpoint for customer-facing chat widgets.
 *                         Caller must supply { tenantId } in the request body.
 *
 * Both routes run the same RAG pipeline (ragService) and share the same
 * Ollama → Grok failover logic.
 */

const express = require('express');
const router  = express.Router();

const { protect, authorize } = require('../middleware/auth');
const { ragQuery }           = require('../services/ragService');
const Service                = require('../models/Service');
const User                   = require('../models/User');

// ─── Shared helper: resolve tenantId for pre-migration admin accounts ─────────
async function resolveTenantId(user) {
  if (user.tenantId) return user.tenantId;
  if (!user.serviceId) return null;

  const svc = await Service.findById(user.serviceId);
  if (!svc) return null;

  await user.updateOne({ tenantId: svc.tenantId });
  user.tenantId = svc.tenantId;
  return svc.tenantId;
}

// ─── Shared helper: get store display name from a tenantId ────────────────────
async function getStoreName(tenantId) {
  try {
    const svc = await Service.findOne({ tenantId });
    return svc?.storeName || svc?.name || 'this store';
  } catch {
    return 'this store';
  }
}

// ─── Shared handler: validate request body ───────────────────────────────────
function validateChatBody(req, res) {
  const { message } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ message: 'message (string) is required' });
    return false;
  }

  if (message.length > 4000) {
    res.status(400).json({ message: 'message must be 4000 characters or fewer' });
    return false;
  }

  return true;
}

// ─── POST /api/admin/chat ─────────────────────────────────────────────────────
// Authenticated — superadmin, admin or user can test their store's assistant.
// Tenant is resolved from the JWT automatically; no need to pass tenantId.
router.post('/admin/chat', protect, authorize('superadmin', 'admin', 'user'), async (req, res) => {
  if (!validateChatBody(req, res)) return;

  const { message, context = [] } = req.body;

  try {
    const tenantId = await resolveTenantId(req.user);

    if (!tenantId) {
      // No service provisioned — still answer, but without RAG context
      console.warn(`⚠️  User ${req.user.email} has no tenantId — answering without RAG context`);
    }

    const storeName = tenantId ? await getStoreName(tenantId) : 'your business';

    const result = await ragQuery({ question: message, context, tenantId, storeName });

    return res.json({
      response:    result.answer,
      model:       result.model,
      usedFallback: result.usedFallback,
      sources:     result.sources,
      timestamp:   new Date(),
    });
  } catch (err) {
    console.error('Admin chat error:', err.message);
    return res.status(503).json({
      message: err.message || 'AI service temporarily unavailable. Please try again.',
    });
  }
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────
// Public — customer-facing chat widget. Caller must provide { tenantId }.
// This endpoint has NO authentication; it relies on tenantId to scope data.
router.post('/chat', async (req, res) => {
  if (!validateChatBody(req, res)) return;

  const { message, context = [], tenantId } = req.body;

  if (!tenantId || typeof tenantId !== 'string') {
    return res.status(400).json({ message: 'tenantId is required for the public chat endpoint' });
  }

  try {
    // Verify tenantId exists (prevents probing for arbitrary collections)
    const svc = await Service.findOne({ tenantId });
    if (!svc) {
      return res.status(404).json({ message: 'Store not found' });
    }

    const storeName = svc.storeName || svc.name || 'this store';

    const result = await ragQuery({ question: message, context, tenantId, storeName });

    return res.json({
      response:    result.answer,
      model:       result.model,
      usedFallback: result.usedFallback,
      sources:     result.sources,
      timestamp:   new Date(),
    });
  } catch (err) {
    console.error('Public chat error:', err.message);
    return res.status(503).json({
      message: err.message || 'AI service temporarily unavailable. Please try again.',
    });
  }
});

module.exports = router;
