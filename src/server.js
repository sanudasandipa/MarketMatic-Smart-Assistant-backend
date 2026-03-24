require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/database');
const { ensureChroma } = require('./utils/chromaManager');

// ── Routes ──────────────────────────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const adminRoutes       = require('./routes/admin');
const superadminRoutes  = require('./routes/superadmin');
const userRoutes        = require('./routes/user');
const documentRoutes    = require('./routes/documents');
const chatRoutes        = require('./routes/chat');
const sessionRoutes     = require('./routes/sessions');
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
app.use('/api/auth',             authRoutes);
app.use('/api/admin',            adminRoutes);
app.use('/api/admin/documents',  documentRoutes);
app.use('/api/admin',            sessionRoutes);  // /sessions, /gaps, /memory
app.use('/api/superadmin',       superadminRoutes);
app.use('/api/user',             userRoutes);
app.use('/api',                  chatRoutes);  // POST /api/admin/chat + POST /api/chat

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
app.listen(PORT, async () => {
  console.log(`🚀  Smart Assistant Backend running on http://localhost:${PORT}`);
  console.log(`    ENV : ${process.env.NODE_ENV || 'development'}`);
  // Auto-start ChromaDB if it is not already running
  ensureChroma().catch((err) => console.error('ChromaDB auto-start error:', err.message));
  // Pre-warm the Ollama chat model so the first real request isn't blocked by
  // cold-load time (llama3.1:8b loads from Modal persistent volume on cold start).
  warmUpOllama();
});

/**
 * Send a minimal prompt to Ollama so the model is loaded into RAM before
 * the first user request arrives.  Runs silently in the background.
 */
async function warmUpOllama() {
  const OLLAMA_URL   = process.env.OLLAMA_URL        || 'http://localhost:11434';
  const OLLAMA_MODEL = process.env.OLLAMA_CHAT_MODEL || 'phi3';
  const TIMEOUT_MS   = parseInt(process.env.OLLAMA_TIMEOUT_MS || '90000', 10);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log(`⏳  Warming up Ollama model '${OLLAMA_MODEL}' in background…`);
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body: JSON.stringify({
        model:    OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream:   false,
      }),
    });
    if (res.ok) {
      console.log(`✅  Ollama '${OLLAMA_MODEL}' is warm and ready.`);
    } else {
      console.warn(`⚠️  Ollama warmup responded with status ${res.status} — model may not be pulled.`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`⚠️  Ollama warmup timed out after ${TIMEOUT_MS / 1000}s — Groq will be used as fallback.`);
    } else {
      console.warn(`⚠️  Ollama warmup failed: ${err.message} — is Ollama running? (run: ollama serve)`);
    }
  } finally {
    clearTimeout(timer);
  }
}

