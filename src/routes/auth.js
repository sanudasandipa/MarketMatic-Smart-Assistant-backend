const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Service = require('../models/Service');
const { sendToken } = require('../utils/tokenHelper');
const { protect } = require('../middleware/auth');

// â”€â”€â”€ POST /api/auth/register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admin self-registration.
// - role is always 'admin'
// - If a Service exists with assignedEmail == email, it gets auto-linked
router.post('/register', async (req, res) => {
  try {
    const { email, username, password, full_name } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ message: 'email, username and password are required' });
    }

    // Check duplicates
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      const field = existing.email === email.toLowerCase() ? 'email' : 'username';
      return res.status(400).json({ message: `${field} is already in use` });
    }

    // Check if superadmin pre-provisioned a service for this email
    const service = await Service.findOne({
      assignedEmail: email.toLowerCase(),
      status: 'pending',
    });

    const user = await User.create({
      email,
      username,
      password,
      full_name: full_name || '',
      role: 'admin',
      // Auto-verify if a service is pre-provisioned
      is_verified: !!service,
      serviceId:   service ? service._id    : null,
      tenantId:    service ? service.tenantId : '',
      storeName:   service ? service.storeName : '',
    });

    // Bind the service to this admin
    if (service) {
      service.adminId = user._id;
      service.status = 'active';
      await service.save();
    }

    return res.status(201).json(user.toSafeObject());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/auth/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Works for both admin and superadmin
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    // Explicitly select password (it's hidden by default)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'Account is deactivated. Contact the platform admin.' });
    }

    return sendToken(user, 200, res);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ GET /api/auth/me â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/me', protect, (req, res) => {
  return res.json(req.user.toSafeObject());
});

// ─── POST /api/auth/register/customer ─────────────────────────────────────────
// Customer self-registration tied to a specific store via tenantId.
// Used by the customer-facing chat widget or embedded portal.
router.post('/register/customer', async (req, res) => {
  try {
    const { email, username, password, full_name, tenantId } = req.body;

    if (!email || !username || !password || !tenantId) {
      return res.status(400).json({ message: 'email, username, password and tenantId are required' });
    }

    const service = await Service.findOne({ tenantId, status: 'active' });
    if (!service) {
      return res.status(404).json({ message: 'Store not found or not active' });
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      const field = existing.email === email.toLowerCase() ? 'email' : 'username';
      return res.status(400).json({ message: `${field} is already in use` });
    }

    const user = await User.create({
      email,
      username,
      password,
      full_name:        full_name || '',
      role:             'user',
      is_verified:      true,
      customerTenantId: tenantId,
      storeName:        service.storeName || service.name || '',
    });

    return res.status(201).json(user.toSafeObject());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// â”€â”€â”€ POST /api/auth/logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// JWT is stateless â€“ logout is handled client-side by discarding the token.
// This endpoint exists for API symmetry and optional server-side logging.
router.post('/logout', protect, (req, res) => {
  return res.json({ message: 'Logged out successfully' });
});

module.exports = router;

