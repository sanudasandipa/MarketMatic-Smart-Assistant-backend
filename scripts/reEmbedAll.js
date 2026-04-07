#!/usr/bin/env node
/**
 * Re-embed all documents in the database using the latest chunking logic.
 *
 * After changing chunkText() in embeddingService.js, existing ChromaDB vectors
 * still use the old broken chunks. This script:
 *   1. Connects to MongoDB and reads all Document records with status 'ready'.
 *   2. For each document, fetches the original text from ChromaDB (reconstructed
 *      from existing chunks) and re-chunks it with the updated logic.
 *   3. Deletes old ChromaDB vectors.
 *   4. Embeds the new chunks and upserts them into ChromaDB.
 *   5. Updates MongoDB records with new chromaIds and chunkCount.
 *
 * Usage:
 *   node scripts/reEmbedAll.js
 *
 * Requirements:
 *   - MongoDB running (MONGO_URI in .env)
 *   - ChromaDB running (CHROMA_URL in .env)
 *   - Ollama running for embeddings
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const Document = require('../src/models/Document');
const { chunkText, embedChunks } = require('../src/services/embeddingService');
const {
  getAllChunks,
  deleteDocumentChunks,
  upsertChunks,
} = require('../src/services/chromaService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/smart_assistant';

async function main() {
  console.log('🔄  Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  // Find all documents that are currently in 'ready' state
  const docs = await Document.find({ status: 'ready' });
  console.log(`📄  Found ${docs.length} document(s) to re-embed\n`);

  if (docs.length === 0) {
    console.log('Nothing to do. Exiting.');
    await mongoose.disconnect();
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const doc of docs) {
    const label = `"${doc.filename}" (tenant: ${doc.tenantId})`;
    console.log(`── Processing ${label} ──`);

    try {
      // 1. Reconstruct text from existing chunks in ChromaDB
      const existingData = await getAllChunks(doc.tenantId);
      const existingDocs = existingData.documents || [];
      const existingMetas = existingData.metadatas || [];
      const existingIds = existingData.ids || [];

      // Filter chunks belonging to this specific document
      const docChunks = [];
      const docChunkIds = [];
      for (let i = 0; i < existingIds.length; i++) {
        if (existingMetas[i]?.documentId === doc._id.toString()) {
          docChunks.push(existingDocs[i]);
          docChunkIds.push(existingIds[i]);
        }
      }

      if (docChunks.length === 0) {
        console.log(`  ⚠️  No existing chunks found in ChromaDB for this document. Skipping.`);
        failCount++;
        continue;
      }

      // Reconstruct the original text from existing chunks
      // (Remove overlap duplicates by taking unique content)
      const reconstructedText = docChunks.join('\n\n');
      console.log(`  📝  Reconstructed text: ${reconstructedText.length} chars from ${docChunks.length} old chunks`);

      // 2. Re-chunk with the new logic
      const newChunks = chunkText(reconstructedText);
      console.log(`  🔪  New chunking: ${newChunks.length} chunks (was ${docChunks.length})`);

      if (newChunks.length === 0) {
        console.log(`  ⚠️  New chunking produced 0 chunks. Skipping to avoid data loss.`);
        failCount++;
        continue;
      }

      // 3. Generate new embeddings
      console.log(`  🧠  Generating embeddings for ${newChunks.length} chunks...`);
      const embeddings = await embedChunks(newChunks);

      // 4. Delete old vectors from ChromaDB
      console.log(`  🗑️  Deleting ${docChunkIds.length} old vectors...`);
      await deleteDocumentChunks(doc.tenantId, docChunkIds);

      // 5. Upsert new vectors
      const newChromaIds = await upsertChunks(
        doc.tenantId,
        newChunks,
        embeddings,
        doc._id.toString(),
        doc.filename
      );
      console.log(`  ✅  Upserted ${newChromaIds.length} new vectors`);

      // 6. Update MongoDB record
      doc.chunkCount = newChunks.length;
      doc.chromaIds = newChromaIds;
      await doc.save();

      console.log(`  ✅  ${label} re-embedded successfully\n`);
      successCount++;
    } catch (err) {
      console.error(`  ❌  Failed to re-embed ${label}: ${err.message}\n`);
      failCount++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Re-embedding complete: ${successCount} succeeded, ${failCount} failed`);
  console.log(`${'='.repeat(50)}`);

  await mongoose.disconnect();
  console.log('🔌  Disconnected from MongoDB');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
