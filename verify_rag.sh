#!/bin/bash
BASE="http://localhost:8000"

echo "================================================"
echo " 1. Admin login"
echo "================================================"
RESP=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citestadmin@example.com","password":"Test@1234"}')
ADMIN_JWT=$(echo "$RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  JWT: ${ADMIN_JWT:0:40}..."

echo ""
echo "================================================"
echo " 2. List documents — check status"
echo "================================================"
sleep 5
DOCS=$(curl -s $BASE/api/admin/documents -H "Authorization: Bearer $ADMIN_JWT")
echo "  Docs: $DOCS"

echo ""
echo "================================================"
echo " 3. ChromaDB collections — check for vectors"
echo "================================================"
# List collections (v2 API)
COLLS=$(curl -s http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections)
echo "  Collections: $COLLS"

echo ""
echo "================================================"
echo " 4. Check backend embedding logs"
echo "================================================"
docker logs smart_assistant_backend --since 3m 2>&1 | grep -iE "embed|chunk|coffee|rag|error|warn|document" | tail -30

echo ""
echo "================================================"
echo " 5. Wait for processing + re-check document status"
echo "================================================"
sleep 10
DOCS2=$(curl -s $BASE/api/admin/documents -H "Authorization: Bearer $ADMIN_JWT")
echo "  Docs: $DOCS2"

echo ""
echo "================================================"
echo " 6. Test customer chat (RAG query)"
echo "================================================"
# Need a user JWT — try to register a test user first
REG=$(curl -s -X POST $BASE/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"rag_test_user@example.com","password":"Test@1234","username":"raguser","full_name":"RAG Tester","role":"user"}')
echo "  Register: $REG"

USER_JWT=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rag_test_user@example.com","password":"Test@1234"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  User JWT: ${USER_JWT:0:40}..."

CHAT=$(curl -s -X POST $BASE/api/chat \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $USER_JWT" \
  -d "{\"message\":\"What is the price of the Arabica coffee blend?\",\"tenantId\":\"coffee-shop-mmdrxx9z\"}")
echo "  Chat response: $CHAT"
