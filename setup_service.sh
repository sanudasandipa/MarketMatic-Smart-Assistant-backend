#!/bin/bash
BASE="http://localhost:8000"

echo "================================================"
echo " 1. Superadmin login"
echo "================================================"
SA_JWT=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"superadmin@platform.com","password":"SuperAdmin@2024"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  SA JWT: ${SA_JWT:0:40}..."

echo ""
echo "================================================"
echo " 2. Create a service (store)"
echo "================================================"
SVC=$(curl -s -X POST $BASE/api/superadmin/services \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SA_JWT" \
  -d '{"name":"Coffee Shop RAG Test","description":"Testing RAG pipeline"}')
echo "  Response: $SVC"
SVC_ID=$(echo "$SVC" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SVC_ID" ] && SVC_ID=$(echo "$SVC" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Service ID: $SVC_ID"

echo ""
echo "================================================"
echo " 3. Get test admin user ID"
echo "================================================"
USERS=$(curl -s $BASE/api/superadmin/users -H "Authorization: Bearer $SA_JWT")
echo "  Users (first 400): ${USERS:0:400}"
ADMIN_ID=$(echo "$USERS" | grep -o '"id":"[^"]*","email":"citestadmin' | cut -d'"' -f4)
[ -z "$ADMIN_ID" ] && ADMIN_ID=$(echo "$USERS" | python3 -c "
import sys,json
users=json.load(sys.stdin)
for u in users:
  if 'citestadmin' in u.get('email',''):
    print(u.get('id') or u.get('_id',''))
    break
" 2>/dev/null)
echo "  Admin ID: $ADMIN_ID"

echo ""
echo "================================================"
echo " 4. Assign service to test admin"
echo "================================================"
if [ -n "$ADMIN_ID" ] && [ -n "$SVC_ID" ]; then
  ASSIGN=$(curl -s -X PATCH $BASE/api/superadmin/users/$ADMIN_ID \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SA_JWT" \
    -d "{\"serviceId\":\"$SVC_ID\"}")
  echo "  Assign response: $ASSIGN"

  # try alternate endpoint
  ASSIGN2=$(curl -s -X PUT $BASE/api/superadmin/users/$ADMIN_ID/service \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SA_JWT" \
    -d "{\"serviceId\":\"$SVC_ID\"}")
  echo "  Assign2 response: $ASSIGN2"
else
  echo "  [SKIP] Missing admin ID or service ID"
fi

echo ""
echo "================================================"
echo " 5. List all superadmin routes for context"
echo "================================================"
echo "Checking available routes..."
curl -s $BASE/api/superadmin/users -H "Authorization: Bearer $SA_JWT" | python3 -c "
import sys,json
try:
  users=json.load(sys.stdin)
  for u in users:
    print('  -', u.get('email'), '| serviceId:', u.get('serviceId'), '| role:', u.get('role'))
except: print('  parse error')
" 2>/dev/null
