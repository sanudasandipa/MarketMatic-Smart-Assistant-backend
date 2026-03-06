/**
 * toolService.js — Agentic Tool Layer
 *
 * Provides configurable "tools" that the Smart Assistant can invoke to retrieve
 * structured, domain-specific information from a store's knowledge base.
 *
 * Each tool:
 *  1. Accepts the user's message and the store's tenantId
 *  2. Runs a targeted ChromaDB query with a tool-specific seed question
 *  3. Returns a formatted context block that is prepended to the main RAG prompt
 *
 * Tools are ONLY executed when:
 *  - The admin has enabled them in their Service.enabledTools array
 *  - The user's message matches the tool's intent keywords
 *
 * Tenant isolation is enforced by scoping all queries to the store's tenantId.
 */

const { getEmbedding }    = require('./embeddingService');
const { queryCollection } = require('./chromaService');

// ─── Tool registry ────────────────────────────────────────────────────────────

/**
 * Each tool definition:
 *  id          – stored in Service.enabledTools
 *  label       – human-readable name shown in settings UI
 *  description – short description for settings UI
 *  seedQuery   – representative question sent to ChromaDB to retrieve relevant chunks
 *  intentWords – if ANY of these appear in the user message, the tool is triggered
 */
const TOOL_REGISTRY = [
  {
    id:          'inventory_check',
    label:       'Inventory Check',
    description: 'Answers questions about product availability, stock levels and variants.',
    seedQuery:   'What products are available? What is the stock level?',
    intentWords: ['available', 'in stock', 'stock', 'inventory', 'have', 'products', 'items', 'carry', 'sell'],
  },
  {
    id:          'business_hours',
    label:       'Business Hours',
    description: 'Answers questions about opening times, holidays and store schedules.',
    seedQuery:   'What are the opening hours? When is the store open?',
    intentWords: ['hours', 'open', 'close', 'opening', 'closing', 'schedule', 'when', 'timing', 'time'],
  },
  {
    id:          'contact_info',
    label:       'Contact Information',
    description: 'Provides store address, phone number, email and social media links.',
    seedQuery:   'What is the store contact information? Phone number, address, email.',
    intentWords: ['contact', 'phone', 'address', 'email', 'reach', 'location', 'find', 'call', 'whatsapp', 'social'],
  },
  {
    id:          'promotions',
    label:       'Promotions & Offers',
    description: 'Shares current deals, discounts and promotional campaigns.',
    seedQuery:   'What are the current promotions, discounts or special offers?',
    intentWords: ['deal', 'offer', 'discount', 'promotion', 'sale', 'promo', 'coupon', 'bundle', 'cheap', 'price'],
  },
  {
    id:          'order_status',
    label:       'Order Status',
    description: 'Provides order tracking, delivery times and return policy information.',
    seedQuery:   'What is the order status, delivery time and return policy?',
    intentWords: ['order', 'delivery', 'tracking', 'shipped', 'return', 'refund', 'status', 'arrive', 'dispatch'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether the user message likely matches a tool's intent.
 * Simple keyword match — fast, no LLM call needed.
 */
function matchesIntent(message, intentWords) {
  const lower = message.toLowerCase();
  return intentWords.some((w) => lower.includes(w.toLowerCase()));
}

/**
 * Retrieve the top-3 most relevant chunks for a given seed query from a tenant's
 * ChromaDB collection. Returns formatted text suitable for use as tool context.
 *
 * @param {string} tenantId
 * @param {string} seedQuery
 * @returns {Promise<string|null>} Formatted context, or null if nothing useful found
 */
async function fetchToolContext(tenantId, seedQuery) {
  let embedding;
  try {
    embedding = await getEmbedding(seedQuery);
  } catch {
    return null;  // embedding unavailable — skip this tool silently
  }

  try {
    const results  = await queryCollection(tenantId, embedding, 3);
    const docs      = results.documents?.[0]  || [];
    const distances = results.distances?.[0]  || [];

    // Only use chunks with cosine distance < 0.45 (high relevance)
    const relevant = docs
      .map((doc, i) => ({ doc, dist: distances[i] }))
      .filter((r) => r.dist <= 0.45 && r.doc.trim().length > 20)
      .map((r) => r.doc);

    if (relevant.length === 0) return null;

    return relevant.join('\n\n');
  } catch {
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all enabled tools that match the user's message intent.
 * Returns a context block that can be prepended to the RAG system prompt.
 *
 * @param {string}   userMessage   - The raw user question
 * @param {string}   tenantId      - Store namespace
 * @param {string[]} enabledTools  - Tool IDs enabled by the admin (from Service.enabledTools)
 *
 * @returns {Promise<string>}  Formatted tool context block, or empty string if no tools fired
 */
async function runEnabledTools(userMessage, tenantId, enabledTools = []) {
  if (!enabledTools.length || !tenantId) return '';

  // Identify which enabled tools match the user's intent
  const triggered = TOOL_REGISTRY.filter(
    (t) => enabledTools.includes(t.id) && matchesIntent(userMessage, t.intentWords)
  );

  if (triggered.length === 0) return '';

  // Fetch context from each triggered tool (parallel for performance)
  const results = await Promise.allSettled(
    triggered.map(async (tool) => {
      const ctx = await fetchToolContext(tenantId, tool.seedQuery);
      return ctx ? { label: tool.label, context: ctx } : null;
    })
  );

  const blocks = results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => `[${r.value.label}]\n${r.value.context}`);

  if (blocks.length === 0) return '';

  const toolBlock =
    `=== TOOL CONTEXT (retrieved by AI agent) ===\n` +
    blocks.join('\n\n---\n\n') +
    `\n=== END TOOL CONTEXT ===`;

  console.log(`🔧  Tool layer: ${blocks.length} tool(s) fired for query`);
  return toolBlock;
}

/**
 * Returns the full tool registry — used by the settings UI.
 */
function getToolRegistry() {
  return TOOL_REGISTRY.map(({ id, label, description }) => ({ id, label, description }));
}

module.exports = { runEnabledTools, getToolRegistry };
