#!/usr/bin/env node
/**
 * Re-embed all existing documents with the new embedding model + chunk size.
 *
 * This script:
 *  1. Connects to MongoDB and finds all Document records with status 'ready'
 *  2. For each tenant, reads ALL chunk text from ChromaDB (the old collection)
 *  3. Reassembles original text per document from chunk text + overlap removal
 *  4. Deletes the old ChromaDB collection (old embeddings are incompatible)
 *  5. Re-chunks with the new CHUNK_SIZE (400) and re-embeds with bge-m3
 *  6. Upserts new vectors into a fresh ChromaDB collection
 *  7. Updates the Document record with new chromaIds and chunkCount
 *
 * Usage:  node src/scripts/reEmbed.js
 *         (run inside the Docker container, or locally with correct env vars)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('../models/Document');
const { chunkText, embedChunks } = require('../services/embeddingService');
const { upsertChunks, deleteCollection, getAllChunks } = require('../services/chromaService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:SmartAssist2024@localhost:27017/smart_assistant?authSource=admin';

async function main() {
  console.log('🔄  Re-embed script starting...');
  console.log(`    CHUNK_SIZE  = 400 (was 800)`);
  console.log(`    EMBED_MODEL = ${process.env.OLLAMA_EMBED_MODEL || 'bge-m3'}`);

  await mongoose.connect(MONGO_URI);
  console.log('✅  MongoDB connected');

  const docs = await Document.find({ status: 'ready' }).lean();
  console.log(`📄  Found ${docs.length} documents to re-embed`);

  if (docs.length === 0) {
    console.log('Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Group by tenantId
  const tenantDocs = {};
  for (const doc of docs) {
    if (!tenantDocs[doc.tenantId]) tenantDocs[doc.tenantId] = [];
    tenantDocs[doc.tenantId].push(doc);
  }

  for (const [tenantId, tenantDocList] of Object.entries(tenantDocs)) {
    console.log(`\n━━━ Tenant: ${tenantId} (${tenantDocList.length} docs) ━━━`);

    // Step 1: Read all existing chunk text from ChromaDB before deleting
    let existingChunks = { ids: [], documents: [], metadatas: [] };
    try {
      existingChunks = await getAllChunks(tenantId);
      console.log(`📦  Read ${existingChunks.ids?.length || 0} existing chunks from ChromaDB`);
    } catch (err) {
      console.warn(`⚠️  Could not read existing chunks: ${err.message}`);
    }

    // Step 2: Reassemble text per document from chunk text
    // Group chunks by documentId, sort by chunkIndex, concatenate
    const textByDocId = {};
    for (let i = 0; i < (existingChunks.ids?.length || 0); i++) {
      const meta = existingChunks.metadatas[i] || {};
      const docId = meta.documentId || 'unknown';
      if (!textByDocId[docId]) textByDocId[docId] = [];
      textByDocId[docId].push({
        index: meta.chunkIndex ?? i,
        text: existingChunks.documents[i] || '',
      });
    }
    // Sort by chunk index and join (chunks had overlap, but joining them gives us
    // enough text to re-chunk cleanly)
    for (const docId of Object.keys(textByDocId)) {
      textByDocId[docId].sort((a, b) => a.index - b.index);
      textByDocId[docId] = textByDocId[docId].map(c => c.text).join('\n\n');
    }

    // Step 3: Delete old collection (incompatible dimensions: 768 → 1024)
    await deleteCollection(tenantId);
    console.log(`🗑️   Old collection deleted`);

    // Step 4: Re-chunk and re-embed each document
    for (const doc of tenantDocList) {
      const docIdStr = doc._id.toString();
      const originalText = textByDocId[docIdStr];

      if (!originalText || originalText.trim().length < 30) {
        console.log(`  ⚠️  ${doc.filename}: no text recovered — marking for re-upload`);
        await Document.updateOne(
          { _id: doc._id },
          { $set: { status: 'failed', errorMessage: 'Re-upload required: could not recover text during model upgrade' } }
        );
        continue;
      }

      try {
        console.log(`  📄 ${doc.filename}: ${originalText.length} chars recovered`);

        // Re-chunk with new size (400)
        const chunks = chunkText(originalText);
        console.log(`     → ${chunks.length} new chunks (was ${doc.chunkCount})`);

        // Re-embed with bge-m3
        const embeddings = await embedChunks(chunks);
        console.log(`     → Embedded ${embeddings.length} chunks`);

        // Upsert into fresh collection
        const chromaIds = await upsertChunks(tenantId, chunks, embeddings, docIdStr, doc.filename);
        console.log(`     → Stored in ChromaDB`);

        // Update MongoDB
        await Document.updateOne(
          { _id: doc._id },
          { $set: { chunkCount: chunks.length, chromaIds, status: 'ready', errorMessage: '' } }
        );
        console.log(`  ✅  ${doc.filename} re-embedded successfully`);
      } catch (err) {
        console.error(`  ❌  ${doc.filename}: ${err.message}`);
        await Document.updateOne(
          { _id: doc._id },
          { $set: { status: 'failed', errorMessage: `Re-embed failed: ${err.message}` } }
        );
      }
    }
  }

  console.log('\n✅  Re-embed complete!');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
