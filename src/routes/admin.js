const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

// All admin routes require authentication + admin or superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// ─── GET /api/admin/dashboard ────────────────────────────────────────────────
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
    return res.status(500).json({ detail: err.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 100;

    const users = await User.find({ role: 'user' })
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    return res.json(users.map((u) => u.toSafeObject()));
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── PUT /api/admin/users/:id ─────────────────────────────────────────────────
router.put('/users/:id', async (req, res) => {
  try {
    const { full_name, username, is_active } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ detail: 'User not found' });

    // Admin can only update regular users
    if (user.role !== 'user') {
      return res.status(403).json({ detail: 'Cannot modify admin or superadmin accounts from here' });
    }

    if (full_name !== undefined) user.full_name = full_name;
    if (username !== undefined) user.username = username;
    if (is_active !== undefined) user.is_active = is_active;

    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ detail: 'User not found' });

    if (user.role !== 'user') {
      return res.status(403).json({ detail: 'Cannot delete admin or superadmin accounts from here' });
    }

    await user.deleteOne();
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    return res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
