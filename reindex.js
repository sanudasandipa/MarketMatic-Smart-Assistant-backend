/**
 * Re-index all documents: delete old ChromaDB chunks, re-chunk with new
 * paragraph-aware strategy, re-embed, and re-upsert.
 *
 * Run from inside the backend container:
 *   node /app/reindex.js
 */
const mongoose = require('mongoose');
const fs = require('fs');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://admin:password@mongo:27017/smart_assistant');
  console.log('Connected to MongoDB');

  const Document = require('./src/models/Document');
  const { chunkText, getEmbedding } = require('./src/services/embeddingService');
  const { upsertChunks, getOrCreateCollection } = require('./src/services/chromaService');
  const { ChromaClient } = require('chromadb');

  const CHROMA_URL = process.env.CHROMA_URL || 'http://chroma:8000';
  const url = new URL(CHROMA_URL);
  const client = new ChromaClient({ host: url.hostname, port: parseInt(url.port || '8000'), ssl: false });

  const docs = await Document.find({ status: 'ready' }).lean();
  console.log('Found ' + docs.length + ' documents');

  if (docs.length === 0) {
    console.log('No documents to process');
    process.exit(0);
  }

  const tenantId = docs[0].tenantId;

  // Step 1: Delete the old collection entirely
  console.log('\n=== Deleting old collection: ' + tenantId + ' ===');
  try {
    await client.deleteCollection({ name: tenantId });
    console.log('Old collection deleted');
  } catch (e) {
    console.log('Delete skipped: ' + e.message);
  }

  // Step 2: Re-process each document
  const docFiles = {
    'store_info.txt': '/app/docs/store_info.txt',
    'return_policy.txt': '/app/docs/return_policy.txt',
    'product_catalog.txt': '/app/docs/product_catalog.txt',
    'pricing_sheet.txt': '/app/docs/pricing_sheet.txt',
    'faq.txt': '/app/docs/faq.txt',
  };

  for (const doc of docs) {
    const filePath = docFiles[doc.filename];
    if (!filePath) {
      console.log('SKIP: No source file for ' + doc.filename);
      continue;
    }

    console.log('\n=== Processing: ' + doc.filename + ' ===');

    // Read original text
    const text = fs.readFileSync(filePath, 'utf-8');
    console.log('Original text length: ' + text.length + ' chars');

    // Chunk with new paragraph-aware strategy
    const chunks = chunkText(text);
    console.log('New chunk count: ' + chunks.length + ' (was: ' + doc.chunkCount + ')');

    // Show chunk previews
    chunks.forEach(function (c, i) {
      console.log('  Chunk ' + i + ' (' + c.length + ' chars): ' + c.substring(0, 120) + '...');
    });

    // Generate embeddings
    console.log('Generating embeddings...');
    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const emb = await getEmbedding(chunks[i]);
      embeddings.push(emb);
      console.log('  Embedded chunk ' + i + '/' + (chunks.length - 1));
    }

    // Upsert to ChromaDB
    console.log('Upserting to ChromaDB...');
    const chromaIds = await upsertChunks(tenantId, chunks, embeddings, doc._id.toString(), doc.filename);
    console.log('Upserted ' + chromaIds.length + ' chunks');

    // Update MongoDB document record
    await Document.updateOne({ _id: doc._id }, { chunkCount: chunks.length, chromaIds: chromaIds });
    console.log('MongoDB record updated');
  }

  // Verify
  console.log('\n=== Verification ===');
  const collection = await getOrCreateCollection(tenantId);
  const count = await collection.count();
  console.log('Total chunks in ChromaDB: ' + count);

  await mongoose.disconnect();
  console.log('\nDone! All documents re-indexed with improved chunking.');
  process.exit(0);
}

main().catch(function (e) {
  console.error('FATAL:', e);
  process.exit(1);
});
