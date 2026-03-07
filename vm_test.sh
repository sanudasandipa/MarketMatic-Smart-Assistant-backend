#!/bin/bash
BASE=http://localhost:8000
TENANT=medihelp-mmg76fsx

echo "========================================"
echo " 5. Store lookup"
echo "========================================"
curl -s $BASE/api/chat/store/$TENANT
echo ""

echo ""
echo "========================================"
echo " 6. RAG query: payment methods"
echo "========================================"
curl -s -X POST $BASE/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"$TENANT\",\"message\":\"what payment methods do you accept?\"}"
echo ""

echo ""
echo "========================================"
echo " 7. RAG query: hello (general)"
echo "========================================"
curl -s -X POST $BASE/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"$TENANT\",\"message\":\"hello\"}"
echo ""

echo ""
echo "========================================"
echo " 8. ChromaDB collections check"
echo "========================================"
curl -s "http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections" | python3 -c "
import sys, json
cols = json.load(sys.stdin)
for c in cols:
    print(f'  Collection: {c[\"name\"]}  dim={c.get(\"dimension\")}')
" 2>/dev/null || curl -s "http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections"

echo ""
echo "========================================"
echo " 9. Backend logs: last RAG activity"
echo "========================================"
docker logs smart_assistant_backend --since 10m 2>&1 | grep -E "RAG|embed|Retrieval|chunks|Ollama|Groq|warm|Connected|ChromaDB" | tail -25
