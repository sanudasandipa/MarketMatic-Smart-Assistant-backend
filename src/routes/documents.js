/**
 * Documents route – knowledge base management for each admin store.
 *
 * POST   /api/admin/documents/upload  – upload a file, extract text, embed, store in Chroma
 * GET    /api/admin/documents         – list all documents for this admin's tenant
 * DELETE /api/admin/documents/:id     – delete document from MongoDB + remove vectors from Chroma
 */

const express  = require('express');
const multer   = require('multer');
const router   = express.Router();

const Document  = require('../models/Document');
const { protect, authorize }              = require('../middleware/auth');
const { extractText, chunkText, embedChunks } = require('../services/embeddingService');
const { upsertChunks, deleteDocumentChunks }  = require('../services/chromaService');

// ─── Multer config ──────────────────────────────────────────────────────────
// Store in memory – we never write the raw file to disk
const ALLOWED_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX and TXT files are supported'));
    }
  },
});

// All routes require authenticated admin (or superadmin)
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// ─── Helper: derive file type label ─────────────────────────────────────────
function getFileType(mimetype) {
  if (mimetype === 'application/pdf')  return 'pdf';
  if (mimetype.includes('wordprocessingml')) return 'docx';
  return 'txt';
}

// ─── Helper: resolve tenantId (backfill for pre-migration accounts) ──────────
// Admins registered before the tenantId field was added to User may have an
// empty tenantId. In that case, derive it from the linked Service and persist
// it so subsequent requests are fast.
async function resolveTenantId(user) {
  if (user.tenantId) return user.tenantId;

  if (!user.serviceId) return null;

  const Service = require('../models/Service');
  const svc = await Service.findById(user.serviceId);
  if (!svc) return null;

  const { tenantId } = svc;
  await user.updateOne({ tenantId });
  user.tenantId = tenantId; // mutate in-memory so current request has it too
  return tenantId;
}

// ─── POST /api/admin/documents/upload ───────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Admin must have a provisioned service.
    // tenantId may be empty for admins registered before this field was added.
    const tenantId = await resolveTenantId(req.user);

    if (!tenantId) {
      return res.status(403).json({
        message: 'No AI service provisioned. Ask the Superadmin to create a service for your email.',
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file attached to the request' });
    }

    const { originalname, buffer, mimetype, size } = req.file;

    // Create a MongoDB record immediately so we have an ID for Chroma chunk IDs
    const doc = await Document.create({
      tenantId,
      adminId:  req.user._id,
      filename: originalname,
      fileType: getFileType(mimetype),
      size,
      status:   'processing',
    });

    // Run extraction + embedding asynchronously so the HTTP response returns fast
    // but update the DB record when done
    setImmediate(async () => {
      try {
        // 1. Extract plain text
        const text   = await extractText(buffer, mimetype);

        // 2. Split into overlapping chunks
        const chunks = chunkText(text);

        if (chunks.length === 0) {
          doc.status       = 'failed';
          doc.errorMessage = 'No usable text could be extracted from the file';
          await doc.save();
          return;
        }

        // 3. Generate embeddings (local Ollama)
        const embeddings = await embedChunks(chunks);

        // 4. Store in ChromaDB under the tenant namespace
        const chromaIds = await upsertChunks(
          tenantId,
          chunks,
          embeddings,
          doc._id.toString(),
          originalname
        );

        // 5. Update MongoDB record
        doc.chunkCount = chunks.length;
        doc.chromaIds  = chromaIds;
        doc.status     = 'ready';
        await doc.save();

        console.log(`✅  Ingested "${originalname}" → ${chunks.length} chunks (tenant: ${tenantId})`);
      } catch (err) {
        console.error(`❌  Ingestion failed for "${originalname}":`, err.message);
        doc.status       = 'failed';
        doc.errorMessage = err.message;
        await doc.save();
      }
    });

    // Return immediately with the processing record
    return res.status(202).json({
      message: 'File received. Embedding in progress — status will update to "ready" shortly.',
      document: {
        id:       doc._id,
        filename: doc.filename,
        fileType: doc.fileType,
        size:     doc.size,
        status:   doc.status,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/documents ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    if (!tenantId) return res.json([]); // no service provisioned yet — return empty list

    const docs = await Document.find({ tenantId })
      .sort({ createdAt: -1 })
      .select('-chromaIds'); // don't expose internal Chroma IDs to the frontend

    return res.json(docs);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /api/admin/documents/:id ────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user);
    if (!tenantId) {
      return res.status(403).json({ message: 'No AI service provisioned for this account.' });
    }

    const doc = await Document.findOne({
      _id:      req.params.id,
      tenantId, // scoped – admin can only delete own documents
    });

    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    // Remove vectors from ChromaDB first
    await deleteDocumentChunks(doc.tenantId, doc.chromaIds);

    // Remove MongoDB record
    await doc.deleteOne();

    return res.json({ message: 'Document and all its vectors deleted successfully' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
