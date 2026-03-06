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

const { protect, authorize }  = require('../middleware/auth');
const { ragQuery }            = require('../services/ragService');
const { runEnabledTools }     = require('../services/toolService');
const { recordKnowledgeGap }  = require('../services/insightsService');
const RagLog                  = require('../models/RagLog');
const Service                 = require('../models/Service');
const User                    = require('../models/User');
const ChatSession              = require('../models/ChatSession');
const UserMemory               = require('../models/UserMemory');

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

// ─── Shared helper: load all store config fields needed by ragQuery ────────────
async function getStoreConfig(tenantId) {
  try {
    const svc = await Service.findOne({ tenantId });
    if (!svc) return { storeName: 'this store', storeCategory: '', assistantTone: 'professional', assistantLanguage: 'en', enabledTools: [] };
    return {
      storeName:         svc.storeName || svc.name || 'this store',
      storeCategory:     svc.storeCategory || '',
      assistantTone:     svc.assistantTone     || 'professional',
      assistantLanguage: svc.assistantLanguage || 'en',
      enabledTools:      svc.enabledTools      || [],
    };
  } catch {
    return { storeName: 'this store', storeCategory: '', assistantTone: 'professional', assistantLanguage: 'en', enabledTools: [] };
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

  const { message, context = [], sessionId } = req.body;

  try {
    const tenantId = await resolveTenantId(req.user);

    if (!tenantId) {
      console.warn(`⚠️  User ${req.user.email} has no tenantId — answering without RAG context`);
    }

    const storeConfig = tenantId ? await getStoreConfig(tenantId) : { storeName: 'your business', storeCategory: '', assistantTone: 'professional', assistantLanguage: 'en', enabledTools: [] };
    const { storeName, storeCategory, assistantTone, assistantLanguage } = storeConfig;

    // ── Load cross-session memory facts and prepend as system context ──────
    let memoryContext = [];
    if (tenantId) {
      try {
        const mem = await UserMemory.findOne({ userId: req.user._id });
        if (mem && mem.facts.length > 0) {
          // Sort by confidence, take top 10
          const topFacts = [...mem.facts]
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 10)
            .map((f) => f.fact);

          memoryContext = [{
            role:    'system',
            content: `[Business Memory from past sessions]\n${topFacts.join('\n')}`,
          }];
        }
      } catch { /* memory is optional — never block chat */ }
    }

    // ── Resolve or auto-create a session ──────────────────────────────────
    let activeSession = null;
    if (sessionId) {
      // Find the existing session — only if it hasn't been ended
      const found = await ChatSession.findOne({ _id: sessionId, userId: req.user._id });
      if (found && !found.isEnded) activeSession = found;
    }

    // Auto-create when no valid session exists but the user has a tenant
    if (!activeSession && tenantId) {
      try {
        activeSession = await ChatSession.create({ userId: req.user._id, tenantId });
      } catch (autoErr) {
        console.warn('⚠️  Auto-session create failed:', autoErr.message);
      }
    }

    // Save user message atomically — no race condition, avoids stale-doc overwrites
    if (activeSession) {
      await ChatSession.updateOne(
        { _id: activeSession._id },
        { $push: { messages: { role: 'user', content: message } } }
      ).catch((err) => console.warn('⚠️  User message save failed:', err.message));
    }

    // Merge memory context at the start of the conversation context
    const enrichedContext = [...memoryContext, ...context];

    // ── Agentic tool layer: run enabled tools if intent matches ──────────────────
    const toolContext = await runEnabledTools(message, tenantId, storeConfig.enabledTools).catch(() => '');
    if (toolContext) {
      enrichedContext.push({ role: 'system', content: toolContext });
    }

    const startTime = Date.now();
    const result = await ragQuery({ question: message, context: enrichedContext, tenantId, storeName, storeCategory, assistantTone, assistantLanguage });
    const responseTimeMs = Date.now() - startTime;

    // ── Non-blocking: write RAG performance log (research metrics) ───────────────
    if (tenantId) {
      RagLog.create({
        tenantId,
        query:             message,
        chunksRetrieved:   result.sources?.length || 0,
        knowledgeSource:   result.knowledgeSource,
        modelUsed:         result.model,
        responseTimeMs,
        fallbackTriggered: result.usedFallback || false,
        confidence:        result.confidence,
      }).catch(() => {});
    }

    // ── Save assistant reply atomically ───────────────────────────────────────
    if (activeSession) {
      await ChatSession.updateOne(
        { _id: activeSession._id },
        { $push: { messages: { role: 'assistant', content: result.answer, knowledgeSource: result.knowledgeSource } } }
      ).catch((err) => console.warn('⚠️  Assistant message save failed:', err.message));
    }

    // ── Record knowledge gap if the answer had no store sources ────────────
    if (tenantId && (!result.sources || result.sources.length === 0)) {
      recordKnowledgeGap(message, tenantId, activeSession?._id || null).catch(() => {});
    }

    return res.json({
      response:        result.answer,
      model:           result.model,
      usedFallback:    result.usedFallback,
      knowledgeSource: result.knowledgeSource,
      confidence:      result.confidence,
      sources:         result.sources,
      sessionId:       activeSession?._id?.toString() || null,
      timestamp:       new Date(),
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

    const storeName         = svc.storeName         || svc.name || 'this store';
    const storeCategory     = svc.storeCategory     || '';
    const assistantTone     = svc.assistantTone     || 'professional';
    const assistantLanguage = svc.assistantLanguage || 'en';
    const enabledTools      = svc.enabledTools      || [];

    // ── Agentic tool layer (public endpoint) ──────────────────────────────
    const toolContext = await runEnabledTools(message, tenantId, enabledTools).catch(() => '');
    const enrichedPublicContext = toolContext
      ? [...context, { role: 'system', content: toolContext }]
      : context;

    const startTime = Date.now();
    const result = await ragQuery({ question: message, context: enrichedPublicContext, tenantId, storeName, storeCategory, assistantTone, assistantLanguage });
    const responseTimeMs = Date.now() - startTime;

    // ── Non-blocking: write RAG performance log ──────────────────────────────
    RagLog.create({
      tenantId,
      query:             message,
      chunksRetrieved:   result.sources?.length || 0,
      knowledgeSource:   result.knowledgeSource,
      modelUsed:         result.model,
      responseTimeMs,
      fallbackTriggered: result.usedFallback || false,
      confidence:        result.confidence,
    }).catch(() => {});

    return res.json({
      response:        result.answer,
      model:           result.model,
      usedFallback:    result.usedFallback,
      knowledgeSource: result.knowledgeSource,
      confidence:      result.confidence,
      sources:         result.sources,
      timestamp:       new Date(),
    });
  } catch (err) {
    console.error('Public chat error:', err.message);
    return res.status(503).json({
      message: err.message || 'AI service temporarily unavailable. Please try again.',
    });
  }
});

module.exports = router;
