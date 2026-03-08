#!/bin/bash
echo "======== 1. MongoDB: all documents (simpler query) ========"
docker exec smart_assistant_mongo mongosh smart_assistant --quiet --eval "
db.documents.find({},{filename:1,status:1,chunkCount:1,tenantId:1}).forEach(function(d){
  printjson({file:d.filename, status:d.status, chunks:d.chunkCount, tenant:d.tenantId});
});" 2>/dev/null

echo ""
echo "======== 2. MongoDB: document count ========"
docker exec smart_assistant_mongo mongosh smart_assistant --quiet --eval "print('Total docs: ' + db.documents.countDocuments());" 2>/dev/null

echo ""
echo "======== 3. ChromaDB: ALL chunk content for medihelp ========"
docker exec smart_assistant_backend node -e "
const {queryCollection} = require('./src/services/chromaService');
const {getEmbedding} = require('./src/services/embeddingService');
async function run() {
  try {
    // Query with a generic word to fetch all stored chunks
    const q = await getEmbedding('pharmacy medicine health store');
    const r = await queryCollection('medihelp-mmg76fsx', q, 20);
    const docs  = (r.documents  && r.documents[0])  || [];
    const meta  = (r.metadatas  && r.metadatas[0])  || [];
    const dist  = (r.distances  && r.distances[0])  || [];
    console.log('Total chunks returned: ' + docs.length);
    docs.forEach((d, i) => {
      console.log('--- chunk ' + i + ' | file=' + (meta[i] && meta[i].filename) + ' | dist=' + dist[i].toFixed(4));
      console.log(d.substring(0, 200));
    });
  } catch(e) { console.error('FAIL:', e.message); }
}
run();
" 2>&1

echo ""
echo "======== 4. Query 'payment methods' — full distance list ========"
docker exec smart_assistant_backend node -e "
const {queryCollection} = require('./src/services/chromaService');
const {getEmbedding} = require('./src/services/embeddingService');
async function run() {
  try {
    const q = await getEmbedding('what payment methods do you accept');
    const r = await queryCollection('medihelp-mmg76fsx', q, 10);
    const docs  = (r.documents  && r.documents[0])  || [];
    const meta  = (r.metadatas  && r.metadatas[0])  || [];
    const dist  = (r.distances  && r.distances[0])  || [];
    const threshold = 0.50;
    docs.forEach((d, i) => {
      const pass = dist[i] <= threshold ? 'PASS' : 'FAIL';
      console.log(pass + ' dist=' + dist[i].toFixed(4) + ' | ' + (meta[i] && meta[i].filename) + ' | ' + d.substring(0, 100));
    });
  } catch(e) { console.error('FAIL:', e.message); }
}
run();
" 2>&1

echo ""
echo "======== 5. FRONTEND_URL / CORS check ========"
docker exec smart_assistant_backend env | grep FRONTEND
