#!/bin/bash
MONGO_URI="mongodb://admin:SmartAssist2024@localhost:27017/smart_assistant?authSource=admin"

echo "======== 1. MongoDB: list all documents WITH AUTH ========"
docker exec smart_assistant_mongo mongosh "$MONGO_URI" --quiet --eval "
db.documents.find({},{filename:1,status:1,chunkCount:1,tenantId:1,createdAt:1}).forEach(function(d){
  print(d.filename + ' | status=' + d.status + ' | chunks=' + d.chunkCount + ' | tenant=' + d.tenantId);
});" 2>/dev/null

echo ""
echo "======== 2. MongoDB: document count + DB name ========"
docker exec smart_assistant_mongo mongosh "$MONGO_URI" --quiet --eval "
print('DB: ' + db.getName());
print('Collections: ' + db.getCollectionNames().join(', '));
print('Document count: ' + db.documents.countDocuments());
" 2>/dev/null

echo ""
echo "======== 3. FULL chunk content that has payment methods ========"
docker exec smart_assistant_backend node -e "
const {queryCollection} = require('./src/services/chromaService');
const {getEmbedding} = require('./src/services/embeddingService');
async function run() {
  try {
    const q = await getEmbedding('payment methods cash credit card');
    const r = await queryCollection('medihelp-mmg76fsx', q, 3);
    const docs  = (r.documents  && r.documents[0])  || [];
    const meta  = (r.metadatas  && r.metadatas[0])  || [];
    const dist  = (r.distances  && r.distances[0])  || [];
    docs.forEach((d, i) => {
      console.log('=== chunk ' + i + ' dist=' + dist[i].toFixed(4) + ' file=' + (meta[i] && meta[i].filename));
      console.log(d);  // FULL content
      console.log('');
    });
  } catch(e) { console.error('FAIL:', e.message); }
}
run();
" 2>&1

echo ""
echo "======== 4. Show threshold vs actual distances (full picture) ========"
docker exec smart_assistant_backend node -e "
const {queryCollection} = require('./src/services/chromaService');
const {getEmbedding} = require('./src/services/embeddingService');
const questions = [
  'what payment methods do you accept',
  'how can I pay',
  'do you accept credit cards',
  'payment options',
  'what are your services'
];
async function run() {
  for (const q of questions) {
    const emb = await getEmbedding(q);
    const r = await queryCollection('medihelp-mmg76fsx', emb, 5);
    const dist = (r.distances && r.distances[0]) || [];
    const best = dist.length > 0 ? dist[0].toFixed(4) : 'none';
    const passing = dist.filter(d => d <= 0.50).length;
    console.log('Q: ' + q);
    console.log('   best_dist=' + best + '  passing_chunks=' + passing + '/' + dist.length);
  }
}
run().catch(e => console.error(e.message));
" 2>&1
