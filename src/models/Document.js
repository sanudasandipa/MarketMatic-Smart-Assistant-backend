/**
 * Document model – tracks knowledge base files uploaded by each admin.
 * The actual text chunks and vectors live in ChromaDB under tenantId namespace.
 * This model stores metadata + the ChromaDB IDs so we can delete vectors later.
 */
const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema(
  {
    // Which tenant (store) owns this document — links to Service.tenantId
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    // The admin who uploaded it
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Original filename shown in the UI
    filename: {
      type: String,
      required: true,
    },
    // pdf | docx | txt
    fileType: {
      type: String,
      enum: ['pdf', 'docx', 'txt'],
      required: true,
    },
    // Number of text chunks stored in ChromaDB
    chunkCount: {
      type: Number,
      default: 0,
    },
    // ChromaDB document IDs for all chunks – needed to delete them later
    chromaIds: {
      type: [String],
      default: [],
    },
    // File size in bytes
    size: {
      type: Number,
      default: 0,
    },
    // processing → ready (or failed if embedding errored)
    status: {
      type: String,
      enum: ['processing', 'ready', 'failed'],
      default: 'processing',
    },
    // Optional error message if status === 'failed'
    errorMessage: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Document', DocumentSchema);
