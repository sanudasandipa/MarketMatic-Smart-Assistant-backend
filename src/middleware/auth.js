const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Protect routes – verify JWT and attach user to req.user
 */
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized – no token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Attach user (without password) to request
    req.user = await User.findById(decoded.id).select('-password');

    if (!req.user) {
      return res.status(401).json({ message: 'User belonging to this token no longer exists' });
    }

    if (!req.user.is_active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

/**
 * Restrict access to specific roles
 * Usage: authorize('superadmin') or authorize('superadmin', 'admin')
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Role '${req.user.role}' is not authorized for this route`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
