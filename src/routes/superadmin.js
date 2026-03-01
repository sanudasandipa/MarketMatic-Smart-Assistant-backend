const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Service = require('../models/Service');
const { protect, authorize } = require('../middleware/auth');

// All routes here require superadmin role
router.use(protect);
router.use(authorize('superadmin'));

// â”€â”€â”€ GET /api/superadmin/dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ GET /api/superadmin/stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns a shape that matches the frontend SystemStats interface:
// { total_users, active_users, superadmins, admins, regular_users, inactive_users }
router.get('/stats', async (req, res) => {
  try {
    const [
      total_users,
      active_users,
      superadmins,
      admins,
      regular_users,
      inactive_users,
      allAdminDetails,
      services,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ is_active: true }),
      User.countDocuments({ role: 'superadmin' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'user' }),
      User.countDocuments({ is_active: false }),
      User.find({ role: 'admin' }).select('-password').sort({ createdAt: -1 }),
      Service.find().sort({ createdAt: -1 }),
    ]);

    return res.json({
      total_users,
      active_users,
      superadmins,
      admins,
      regular_users,
      inactive_users,
      // Extended details (optional, used by future features)
      adminDetails: allAdminDetails.map((a) => a.toSafeObject()),
      services,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ GET /api/superadmin/users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/superadmin/users/:id/promote-to-admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/users/:id/promote-to-admin', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot change your own role' });
    }
    user.role = 'admin';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/superadmin/users/:id/promote-to-superadmin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/users/:id/promote-to-superadmin', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.role = 'superadmin';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/superadmin/users/:id/demote-to-user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/users/:id/demote-to-user', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot change your own role' });
    }
    user.role = 'user';
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ DELETE /api/superadmin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Superadmin can delete any account (admin or other superadmin) except their own
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }
    await user.deleteOne();
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/superadmin/users/:id/toggle-active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/users/:id/toggle-active', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot deactivate your own account' });
    }
    user.is_active = !user.is_active;
    await user.save();
    return res.json(user.toSafeObject());
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SERVICE PROVISIONING ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€â”€ POST /api/superadmin/services â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Create a new service (pre-assign to an admin email)
router.post('/services', async (req, res) => {
  try {
    const { name, assignedEmail, storeName, storeCategory } = req.body;

    if (!name || !assignedEmail) {
      return res.status(400).json({ message: 'name and assignedEmail are required' });
    }

    // If that email already has a service, prevent duplicate
    const existing = await Service.findOne({ assignedEmail: assignedEmail.toLowerCase() });
    if (existing) {
      return res.status(400).json({ message: 'A service is already assigned to this email' });
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
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ GET /api/superadmin/services â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/services', async (req, res) => {
  try {
    const services = await Service.find()
      .populate('adminId', 'email username full_name')
      .populate('createdBy', 'email username')
      .sort({ createdAt: -1 });

    return res.json(services);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ DELETE /api/superadmin/services/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/services/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ message: 'Service not found' });
    await service.deleteOne();
    return res.json({ message: 'Service deleted' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;

