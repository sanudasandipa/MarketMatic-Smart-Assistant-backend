const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Service = require('../models/Service');
const { protect, authorize } = require('../middleware/auth');

// All routes here require superadmin role
router.use(protect);
router.use(authorize('superadmin'));

// ─── GET /api/superadmin/dashboard ───────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [totalAdmins, totalUsers, totalServices, activeServices] = await Promise.all([
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'user' }),
      Service.countDocuments(),
      Service.countDocuments({ status: 'active' }),
    ]);

    return res.json({
      message: `Welcome, ${req.user.full_name || req.user.username}`,
      superadmin: req.user.toSafeObject(),
      stats: {
        totalAdmins,
        totalUsers,
        totalServices,
        activeServices,
        pendingServices: totalServices - activeServices,
      },
    });
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── GET /api/superadmin/stats ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [admins, users, services] = await Promise.all([
      User.find({ role: 'admin' }).select('-password').sort({ createdAt: -1 }),
      User.countDocuments({ role: 'user' }),
      Service.find().sort({ createdAt: -1 }),
    ]);

    return res.json({
      admins: admins.map((a) => a.toSafeObject()),
      totalUsers: users,
      services,
    });
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── GET /api/superadmin/users ────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 100;

    const users = await User.find()
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    return res.json(users.map((u) => u.toSafeObject()));
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── POST /api/superadmin/users/:id/promote-to-admin ─────────────────────────
router.post('/users/:id/promote-to-admin', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ detail: 'User not found' });
    if (user.role === 'superadmin') {
      return res.status(400).json({ detail: 'Cannot change superadmin role' });
    }
    user.role = 'admin';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── POST /api/superadmin/users/:id/promote-to-superadmin ────────────────────
router.post('/users/:id/promote-to-superadmin', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ detail: 'User not found' });
    user.role = 'superadmin';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── POST /api/superadmin/users/:id/demote-to-user ───────────────────────────
router.post('/users/:id/demote-to-user', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ detail: 'User not found' });
    if (user.role === 'superadmin') {
      return res.status(400).json({ detail: 'Cannot demote a superadmin' });
    }
    user.role = 'user';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── POST /api/superadmin/users/:id/toggle-active ────────────────────────────
router.post('/users/:id/toggle-active', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ detail: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ detail: 'Cannot deactivate your own account' });
    }
    user.is_active = !user.is_active;
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SERVICE PROVISIONING ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/superadmin/services ────────────────────────────────────────────
// Create a new service (pre-assign to an admin email)
router.post('/services', async (req, res) => {
  try {
    const { name, assignedEmail, storeName, storeCategory } = req.body;

    if (!name || !assignedEmail) {
      return res.status(400).json({ detail: 'name and assignedEmail are required' });
    }

    // If that email already has a service, prevent duplicate
    const existing = await Service.findOne({ assignedEmail: assignedEmail.toLowerCase() });
    if (existing) {
      return res.status(400).json({ detail: 'A service is already assigned to this email' });
    }

    const service = await Service.create({
      name,
      assignedEmail,
      storeName: storeName || '',
      storeCategory: storeCategory || '',
      createdBy: req.user._id,
    });

    return res.status(201).json(service);
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── GET /api/superadmin/services ────────────────────────────────────────────
router.get('/services', async (req, res) => {
  try {
    const services = await Service.find()
      .populate('adminId', 'email username full_name')
      .populate('createdBy', 'email username')
      .sort({ createdAt: -1 });

    return res.json(services);
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── DELETE /api/superadmin/services/:id ─────────────────────────────────────
router.delete('/services/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ detail: 'Service not found' });
    await service.deleteOne();
    return res.json({ message: 'Service deleted' });
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
