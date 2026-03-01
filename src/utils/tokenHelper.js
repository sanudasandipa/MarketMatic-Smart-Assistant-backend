const jwt = require('jsonwebtoken');

/**
 * Sign a JWT token for the given user id
 */
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

/**
 * Build a standardised auth response
 */
const sendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  return res.status(statusCode).json({
    access_token: token,
    token_type: 'Bearer',
    user: user.toSafeObject(),
  });
};

module.exports = { signToken, sendToken };
