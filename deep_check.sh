#!/bin/bash
echo "======== 1. ChromaDB collections + chunk counts ========"
curl -s 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections' | python3 -c "
import sys,json
try:
    cols=json.load(sys.stdin)
    for c in cols:
        print('  name=%s  dim=%s' % (c['name'], c.get('dimension','?')))
except Exception as e:
    print('parse error:',e)
"

echo ""
echo "======== 2. MongoDB documents ========"
docker exec smart_assistant_mongo mongosh --quiet --eval "
db = db.getSiblingDB('smart_assistant');
var docs = db.documents.find({},{filename:1,status:1,chunkCount:1,tenantId:1,createdAt:1}).toArray();
docs.forEach(function(d){ print(d.tenantId + ' | ' + d.filename + ' | status=' + d.status + ' | chunks=' + d.chunkCount); });
" 2>/dev/null

echo ""
echo "======== 3. Embedding dimension test ========"
docker exec smart_assistant_backend node -e "
const s = require('./src/services/embeddingService');
s.getEmbedding('test').then(v => console.log('EMBED_DIM=' + v.length)).catch(e => console.error('EMBED_FAIL:', e.message));
" 2>&1

echo ""
echo "======== 4. Live ChromaDB distance test ========"
docker exec smart_assistant_backend node -e "
const {getEmbedding} = require('./src/services/embeddingService');
const {queryCollection} = require('./src/services/chromaService');
async function run() {
  try {
    const q = await getEmbedding('what payment methods do you accept');
    const r = await queryCollection('medihelp-mmg76fsx', q, 5);
    const docs = r.documents && r.documents[0] ? r.documents[0] : [];
    const dist = r.distances && r.distances[0] ? r.distances[0] : [];
    if (docs.length === 0) { console.log('NO RESULTS from ChromaDB'); return; }
    docs.forEach((d, i) => console.log('dist=' + dist[i].toFixed(4) + ' PASS=' + (dist[i] <= 0.50) + ' | ' + d.substring(0, 90)));
  } catch(e) { console.error('FAIL:', e.message); }
}
run();
" 2>&1

echo ""
echo "======== 5. RAG_RELEVANCE_THRESHOLD in backend ========"
docker exec smart_assistant_backend env | grep -E "RAG|CHROMA|OLLAMA|GROQ" | sort
