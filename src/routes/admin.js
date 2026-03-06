const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Service = require('../models/Service');
const Document = require('../models/Document');
const KnowledgeGap = require('../models/KnowledgeGap');
const RagLog = require('../models/RagLog');
const { protect, authorize } = require('../middleware/auth');
const { getToolRegistry } = require('../services/toolService');

// All admin routes require authentication + admin or superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// ─── Shared: resolve tenantId for admin user ────────────────────────────────
async function resolveTenantId(user) {
  if (user.tenantId) return user.tenantId;
  if (!user.serviceId) return null;
  const svc = await Service.findById(user.serviceId);
  if (!svc) return null;
  return svc.tenantId;
}

// â”€â”€â”€ GET /api/admin/dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/dashboard', async (req, res) => {
  try {
    // Admin sees stats scoped to their own store/service
    const totalUsers = await User.countDocuments({ role: 'user' });

    return res.json({
      message: `Welcome to Admin Dashboard, ${req.user.full_name || req.user.username}`,
      admin: req.user.toSafeObject(),
      stats: {
        totalCustomers: totalUsers,
        storeName: req.user.storeName || 'N/A',
        serviceId: req.user.serviceId,
        accountVerified: req.user.is_verified,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/service ──────────────────────────────────────────────────
// Returns the admin's provisioned service record including the tenantId
// (used as the RAG namespace / unique AI service token for this store)
router.get('/service', async (req, res) => {
  try {
    if (!req.user.serviceId) {
      return res.status(404).json({
        message: 'No service provisioned for your account. Contact the Superadmin.',
      });
    }

    const service = await Service.findById(req.user.serviceId);
    if (!service) {
      return res.status(404).json({ message: 'Service record not found' });
    }

    return res.json(service);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Returns only customers (role:'user') who registered under this admin's store.
router.get('/users', async (req, res) => {
  try {
    const skip  = parseInt(req.query.skip)  || 0;
    const limit = parseInt(req.query.limit) || 100;

    const tenantId = await resolveTenantId(req.user);

    // Build filter: if admin has a tenantId, scope to their store's customers.
    // Superadmin (no tenantId) sees all users for oversight.
    const filter = { role: 'user' };
    if (tenantId && req.user.role !== 'superadmin') {
      filter.customerTenantId = tenantId;
    }

    const users = await User.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    return res.json(users.map((u) => u.toSafeObject()));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ PUT /api/admin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/users/:id', async (req, res) => {
  try {
    const { full_name, username, is_active } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Admin can only update regular users
    if (user.role !== 'user') {
      return res.status(403).json({ message: 'Cannot modify admin or superadmin accounts from here' });
    }

    if (full_name !== undefined) user.full_name = full_name;
    if (username !== undefined) user.username = username;
    if (is_active !== undefined) user.is_active = is_active;

    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ DELETE /api/admin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.role !== 'user') {
      return res.status(403).json({ message: 'Cannot delete admin or superadmin accounts from here' });
    }

    await user.deleteOne();
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/ai-metrics ───────────────────────────────────────────────
router.get('/ai-metrics', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    if (!tenantId) return res.status(404).json({ message: 'No service provisioned' });

    const [totalQueries, totalGaps, totalDocuments, allLogs] = await Promise.all([
      RagLog.countDocuments({ tenantId }),
      KnowledgeGap.countDocuments({ tenantId }),
      Document.countDocuments({ tenantId }),
      RagLog.find({ tenantId })
        .select('modelUsed fallbackTriggered responseTimeMs knowledgeSource confidence')
        .lean(),
    ]);

    const modelUsage = {};
    let totalFallbacks   = 0;
    let totalResponseMs  = 0;
    let storeAnswers     = 0;

    for (const log of allLogs) {
      const key = log.modelUsed || 'unknown';
      modelUsage[key] = (modelUsage[key] || 0) + 1;
      if (log.fallbackTriggered) totalFallbacks++;
      if (log.responseTimeMs)    totalResponseMs += log.responseTimeMs;
      if (log.knowledgeSource === 'store') storeAnswers++;
    }

    return res.json({
      totalQueries,
      totalGaps,
      totalDocuments,
      modelUsage,
      fallbackRate:        totalQueries > 0 ? parseFloat(((totalFallbacks / totalQueries) * 100).toFixed(1)) : 0,
      avgResponseTimeMs:   totalQueries > 0 ? Math.round(totalResponseMs / totalQueries) : 0,
      storeKnowledgeRate:  totalQueries > 0 ? parseFloat(((storeAnswers  / totalQueries) * 100).toFixed(1)) : 0,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/gaps/analytics ─────────────────────────────────────────
router.get('/gaps/analytics', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    if (!tenantId) return res.status(404).json({ message: 'No service provisioned' });

    const [topGaps, totalGaps, unresolvedGaps] = await Promise.all([
      KnowledgeGap.find({ tenantId })
        .sort({ frequency: -1 })
        .limit(10)
        .select('question frequency lastAsked resolved')
        .lean(),
      KnowledgeGap.countDocuments({ tenantId }),
      KnowledgeGap.countDocuments({ tenantId, resolved: false }),
    ]);

    return res.json({ topGaps, totalGaps, unresolvedGaps });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/tools ─────────────────────────────────────────────────────
// Returns the full tool registry (all available tools) and which ones are enabled.
router.get('/tools', async (req, res) => {
  try {
    const registry = getToolRegistry();
    if (!req.user.serviceId) {
      return res.json({ tools: registry, enabledTools: [], assistantTone: 'professional', assistantLanguage: 'en' });
    }
    const service = await Service.findById(req.user.serviceId);
    return res.json({
      tools:             registry,
      enabledTools:      service?.enabledTools      || [],
      assistantTone:     service?.assistantTone     || 'professional',
      assistantLanguage: service?.assistantLanguage || 'en',
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── PUT /api/admin/service/settings ─────────────────────────────────────────
// Admin updates AI assistant configuration: enabled tools, tone, language.
router.put('/service/settings', async (req, res) => {
  try {
    if (!req.user.serviceId) {
      return res.status(404).json({ message: 'No service provisioned for your account.' });
    }

    const { enabledTools, assistantTone, assistantLanguage } = req.body;

    const VALID_TONES = ['professional', 'friendly', 'concise'];
    const allowedToolIds = getToolRegistry().map((t) => t.id);

    const update = {};

    if (Array.isArray(enabledTools)) {
      // Whitelist: only accept known tool IDs
      update.enabledTools = enabledTools.filter((id) => allowedToolIds.includes(id));
    }
    if (assistantTone && VALID_TONES.includes(assistantTone)) {
      update.assistantTone = assistantTone;
    }
    if (assistantLanguage && typeof assistantLanguage === 'string' && assistantLanguage.length <= 10) {
      update.assistantLanguage = assistantLanguage;
    }

    const service = await Service.findByIdAndUpdate(
      req.user.serviceId,
      { $set: update },
      { new: true }
    );

    if (!service) return res.status(404).json({ message: 'Service not found' });

    return res.json({
      message:           'Assistant settings updated',
      enabledTools:      service.enabledTools,
      assistantTone:     service.assistantTone,
      assistantLanguage: service.assistantLanguage,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;

