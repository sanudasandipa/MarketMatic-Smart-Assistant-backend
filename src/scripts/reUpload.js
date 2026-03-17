#!/usr/bin/env node
/**
 * Re-upload script — reads .txt files from /tmp/docs/, chunks + embeds with
 * the current model (bge-m3), and upserts into ChromaDB.
 * Updates the corresponding MongoDB Document records.
 *
 * Usage:  TENANT_ID=kumara-stores-mmi1hn8v node src/scripts/reUpload.js
 */

const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');
const Document = require('../models/Document');
const { chunkText, embedChunks } = require('../services/embeddingService');
const { upsertChunks, deleteCollection } = require('../services/chromaService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:SmartAssist2024@localhost:27017/smart_assistant?authSource=admin';
const TENANT_ID = process.env.TENANT_ID;
const DOCS_DIR  = process.env.DOCS_DIR || '/tmp/docs';

async function main() {
  if (!TENANT_ID) {
    console.error('ERROR: Set TENANT_ID env var');
    process.exit(1);
  }

  console.log(`🔄  Re-upload for tenant: ${TENANT_ID}`);
  console.log(`    DOCS_DIR = ${DOCS_DIR}`);
  console.log(`    EMBED_MODEL = ${process.env.OLLAMA_EMBED_MODEL || 'bge-m3'}`);

  await mongoose.connect(MONGO_URI);
  console.log('✅  MongoDB connected');

  // Delete old ChromaDB collection for this tenant
  try {
    await deleteCollection(TENANT_ID);
    console.log(`🗑️  Deleted old ChromaDB collection: ${TENANT_ID}`);
  } catch (e) {
    console.log(`ℹ️  No existing collection to delete`);
  }

  // Read all .txt files from the docs directory
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt'));
  console.log(`📄  Found ${files.length} files in ${DOCS_DIR}`);

  for (const filename of files) {
    const filePath = path.join(DOCS_DIR, filename);
    const text = fs.readFileSync(filePath, 'utf-8');
    console.log(`\n  📄 ${filename}: ${text.length} chars`);

    // Chunk
    const chunks = chunkText(text, filename);
    console.log(`     → ${chunks.length} chunks`);

    // Embed
    const embeddings = await embedChunks(chunks);
    console.log(`     → Embedded ${embeddings.length} chunks`);

    // Find existing MongoDB document record
    const doc = await Document.findOne({ tenantId: TENANT_ID, filename });
    if (!doc) {
      console.log(`  ⚠️  No MongoDB record for ${filename} — skipping`);
      continue;
    }

    // Upsert to ChromaDB
    const chromaIds = await upsertChunks(TENANT_ID, chunks, embeddings, doc._id.toString(), filename);
    console.log(`     → Stored in ChromaDB`);

    // Update MongoDB document record
    await Document.findByIdAndUpdate(doc._id, {
      $set: {
        status: 'ready',
        chunkCount: chunks.length,
        chromaIds,
        errorMessage: null,
      }
    });
    console.log(`  ✅  ${filename} done`);
  }

  console.log('\n✅  Re-upload complete!');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
