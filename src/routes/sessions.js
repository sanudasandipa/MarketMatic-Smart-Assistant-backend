/**
 * Sessions Routes – /api/admin/sessions
 *
 * GET    /api/admin/sessions           — list all sessions for the current user (newest first)
 * POST   /api/admin/sessions           — create a new session
 * GET    /api/admin/sessions/:id       — get one session with messages
 * DELETE /api/admin/sessions/:id       — delete a session
 * PATCH  /api/admin/sessions/:id/end   — mark session ended, trigger insights + memory
 *
 * GET    /api/admin/gaps               — list knowledge gaps for this tenant
 * PATCH  /api/admin/gaps/:id/resolve   — mark a gap resolved
 * GET    /api/admin/memory             — get persistent memory facts for this user
 */

const express   = require('express');
const router    = express.Router();

const { protect, authorize } = require('../middleware/auth');
const ChatSession  = require('../models/ChatSession');
const KnowledgeGap = require('../models/KnowledgeGap');
const UserMemory   = require('../models/UserMemory');
const Service      = require('../models/Service');
const User         = require('../models/User');
const { generateSessionInsights, extractMemoryFacts } = require('../services/insightsService');

// ─── Shared: resolve tenantId ─────────────────────────────────────────────────
async function resolveTenantId(user) {
  if (user.tenantId) return user.tenantId;
  if (!user.serviceId) return null;
  const svc = await Service.findById(user.serviceId);
  if (!svc) return null;
  await user.updateOne({ tenantId: svc.tenantId });
  user.tenantId = svc.tenantId;
  return svc.tenantId;
}

const auth = [protect, authorize('superadmin', 'admin', 'user')];

// ─── Sessions CRUD ─────────────────────────────────────────────────────────────

// List sessions (newest first, no messages in list view)
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('-messages')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create new session
router.post('/sessions', auth, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);

    if (!tenantId) {
      return res.status(400).json({ message: 'No service provisioned — cannot create session' });
    }

    const session = await ChatSession.create({
      userId:   req.user._id,
      tenantId,
    });

    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get one session with full messages
router.get('/sessions/:id', auth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!session) return res.status(404).json({ message: 'Session not found' });

    res.json({ session });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete session
router.delete('/sessions/:id', auth, async (req, res) => {
  try {
    const session = await ChatSession.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!session) return res.status(404).json({ message: 'Session not found' });

    res.json({ message: 'Session deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// End session — triggers insights generation + memory extraction (async background tasks)
router.patch('/sessions/:id/end', auth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!session) return res.status(404).json({ message: 'Session not found' });

    session.isEnded = true;
    await session.save();

    // Run insights + memory extraction in background (don't block response)
    setImmediate(async () => {
      try {
        if (!session.insightsGenerated && session.messages.length >= 2) {
          const insights = await generateSessionInsights(session);
          await ChatSession.updateOne(
            { _id: session._id },
            {
              title:    insights.title,
              summary:  insights.summary,
              topicTag: insights.topicTag,
              insightsGenerated: true,
            }
          );
          console.log(`✅  Session insights generated: "${insights.title}" [${insights.topicTag}]`);
        }

        if (!session.memoryExtracted && session.messages.length >= 4) {
          await extractMemoryFacts(session, req.user._id);
          await ChatSession.updateOne({ _id: session._id }, { memoryExtracted: true });
          console.log(`✅  Memory facts extracted for user ${req.user._id}`);
        }
      } catch (err) {
        console.error('⚠️  Background insights/memory error:', err.message);
      }
    });

    res.json({ message: 'Session ended', sessionId: session._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Knowledge Gaps ───────────────────────────────────────────────────────────

router.get('/gaps', auth, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    if (!tenantId) return res.json({ gaps: [] });

    const gaps = await KnowledgeGap.find({ tenantId, resolved: false })
      .sort({ frequency: -1, lastAsked: -1 })
      .limit(50);

    res.json({ gaps });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/gaps/:id/resolve', auth, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    const gap = await KnowledgeGap.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { resolved: true },
      { new: true }
    );
    if (!gap) return res.status(404).json({ message: 'Gap not found' });
    res.json({ gap });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Cross-session Memory ─────────────────────────────────────────────────────

router.get('/memory', auth, async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ userId: req.user._id });
    res.json({ facts: memory?.facts || [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a specific memory fact
router.delete('/memory/:factId', auth, async (req, res) => {
  try {
    const memory = await UserMemory.findOneAndUpdate(
      { userId: req.user._id },
      { $pull: { facts: { _id: req.params.factId } } },
      { new: true }
    );
    res.json({ facts: memory?.facts || [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
