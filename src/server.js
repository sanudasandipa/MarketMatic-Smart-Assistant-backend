require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/database');

// ── Routes ──────────────────────────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const adminRoutes       = require('./routes/admin');
const superadminRoutes  = require('./routes/superadmin');
const userRoutes        = require('./routes/user');
const documentRoutes    = require('./routes/documents');
const chatRoutes        = require('./routes/chat');
// ── App ──────────────────────────────────────────────────────────────────────
const app = express();

// Connect to MongoDB
connectDB();

// ── Global Middleware ─────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'smart-assistant-backend', timestamp: new Date() });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/admin/documents', documentRoutes);
app.use('/api/superadmin',  superadminRoutes);
app.use('/api/user',        userRoutes);
app.use('/api',             chatRoutes);  // POST /api/admin/chat + POST /api/chat

// ── 404 Handler ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀  Smart Assistant Backend running on http://localhost:${PORT}`);
  console.log(`    ENV : ${process.env.NODE_ENV || 'development'}`);
});
