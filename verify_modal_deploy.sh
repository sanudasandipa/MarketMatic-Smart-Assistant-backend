#!/bin/bash
# Full deployment verification for new VM with Modal remote GPU
BASE="http://localhost:8000"

echo "=== 1. Health check ==="
curl -s "$BASE/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ Backend:', d['status'])" 2>/dev/null

echo ""
echo "=== 2. Container status ==="
docker ps --format "  {{.Names}} — {{.Status}}"

echo ""
echo "=== 3. Modal endpoint connectivity ==="
MODAL_URL=$(docker exec smart_assistant_backend sh -c 'echo $OLLAMA_URL' 2>/dev/null)
echo "  Modal URL: $MODAL_URL"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${MODAL_URL}/api/version" 2>/dev/null)
echo "  /api/version response: HTTP $HTTP_CODE"

echo ""
echo "=== 4. ChromaDB status ==="
curl -s http://localhost:8001/api/v2/heartbeat | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ ChromaDB:', d)" 2>/dev/null || echo "  ⚠️ ChromaDB heartbeat failed"

echo ""
echo "=== 5. Backend startup logs (last 20 lines) ==="
docker logs smart_assistant_backend 2>&1 | tail -20
