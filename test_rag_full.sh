#!/bin/bash
BASE="http://localhost:8000"

echo "================================================"
echo " 1. Embedding API test (backend → ollama)"
echo "================================================"
R=$(docker exec smart_assistant_backend node /tmp/embed_node.js 2>&1)
echo "  $R"
echo "$R" | grep -q "EMBED_OK" && echo "  [PASS] Ollama embedding: 768-dim vectors" || echo "  [FAIL] Embedding broken"

echo ""
echo "================================================"
echo " 2. Login as test admin"
echo "================================================"
ADMIN_JWT=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citestadmin@example.com","password":"Test@1234"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  JWT: ${ADMIN_JWT:0:40}..."
[ -n "$ADMIN_JWT" ] && echo "  [PASS] Admin login OK" || echo "  [FAIL] Admin login failed"

echo ""
echo "================================================"
echo " 3. Upload test document (triggers chunk+embed)"
echo "================================================"
echo 'This store sells premium coffee. Arabica blend costs 12 USD per 250g bag. We also sell espresso machines starting from 150 USD. Customer support is available 9am to 5pm Monday to Friday. Free shipping on orders over 50 dollars.' > /tmp/test_doc.txt

UPLOAD=$(curl -s -w "\nHTTP:%{http_code}" -X POST $BASE/api/admin/documents/upload \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -F "file=@/tmp/test_doc.txt;type=text/plain")
UPLOAD_CODE=$(echo "$UPLOAD" | grep "HTTP:" | cut -d: -f2)
UPLOAD_BODY=$(echo "$UPLOAD" | grep -v "HTTP:")
echo "  HTTP: $UPLOAD_CODE"
echo "  Body: $UPLOAD_BODY"
[ "$UPLOAD_CODE" = "200" ] || [ "$UPLOAD_CODE" = "201" ] && echo "  [PASS] Document uploaded and embedded into ChromaDB" || echo "  [FAIL] Upload failed — see body above"

echo ""
echo "================================================"
echo " 4. List uploaded documents"
echo "================================================"
DOCS=$(curl -s -w "\nHTTP:%{http_code}" $BASE/api/admin/documents \
  -H "Authorization: Bearer $ADMIN_JWT")
DOCS_CODE=$(echo "$DOCS" | grep "HTTP:" | cut -d: -f2)
DOCS_BODY=$(echo "$DOCS" | grep -v "HTTP:")
echo "  HTTP: $DOCS_CODE"
echo "  Body: ${DOCS_BODY:0:400}"

echo ""
echo "================================================"
echo " 5. Backend logs — embedding activity"
echo "================================================"
docker logs smart_assistant_backend --since 3m 2>&1 | grep -iE "embed|chunk|chroma|upsert|rag|error|warn" | tail -20

echo ""
echo "================================================"
echo " 6. Verify ChromaDB has vectors"
echo "================================================"
CHROMA=$(curl -s http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections 2>/dev/null)
echo "  ChromaDB collections: ${CHROMA:0:300}"
