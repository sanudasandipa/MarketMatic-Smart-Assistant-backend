const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');

// All routes here require logged-in user (any role)
router.use(protect);

// â”€â”€â”€ GET /api/user/dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/dashboard', (req, res) => {
  return res.json({
    message: `Welcome, ${req.user.full_name || req.user.username}`,
    user: req.user.toSafeObject(),
  });
});

module.exports = router;

