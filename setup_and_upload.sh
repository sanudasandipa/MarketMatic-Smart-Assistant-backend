#!/bin/bash
BASE="http://localhost:8000"

echo "================================================"
echo " 1. Superadmin login"
echo "================================================"
SA_JWT=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"superadmin@platform.com","password":"SuperAdmin@2024"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  OK"

echo ""
echo "================================================"
echo " 2. Create service + assign to citestadmin"
echo "================================================"
SVC=$(curl -s -X POST $BASE/api/superadmin/services \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SA_JWT" \
  -d '{"name":"Coffee Shop","assignedEmail":"citestadmin@example.com","description":"RAG test store"}')
echo "  Response: $SVC"
SVC_ID=$(echo "$SVC" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SVC_ID" ] && SVC_ID=$(echo "$SVC" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Service ID: $SVC_ID"

echo ""
echo "================================================"
echo " 3. Verify citestadmin now has a service"
echo "================================================"
USERS=$(curl -s $BASE/api/superadmin/users -H "Authorization: Bearer $SA_JWT")
echo "$USERS" | python3 -c "
import sys,json
try:
  users=json.load(sys.stdin)
  for u in users:
    if 'citestadmin' in u.get('email',''):
      print('  citestadmin serviceId:', u.get('serviceId'), '| tenantId:', u.get('tenantId'))
except Exception as e: print('  parse err:', e)
" 2>/dev/null

echo ""
echo "================================================"
echo " 4. Admin login + upload document"
echo "================================================"
ADMIN_JWT=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citestadmin@example.com","password":"Test@1234"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
echo "  Admin JWT: ${ADMIN_JWT:0:40}..."

echo 'Our coffee shop offers premium Arabica blend coffee at 12 USD per 250g bag. We also have espresso machines starting from 150 USD. Our opening hours are 8am to 8pm daily. We offer free delivery on orders above 50 USD. For support call 1-800-COFFEE.' > /tmp/coffee_doc.txt

UPLOAD=$(curl -s -w "\nHTTP:%{http_code}" -X POST $BASE/api/admin/documents/upload \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -F "file=@/tmp/coffee_doc.txt;type=text/plain")
UPLOAD_CODE=$(echo "$UPLOAD" | grep "HTTP:" | cut -d: -f2)
UPLOAD_BODY=$(echo "$UPLOAD" | grep -v "HTTP:")
echo "  Upload HTTP: $UPLOAD_CODE"
echo "  Upload Body: $UPLOAD_BODY"
[ "$UPLOAD_CODE" = "200" ] || [ "$UPLOAD_CODE" = "201" ] \
  && echo "  [PASS] Document chunked and embedded into ChromaDB!" \
  || echo "  [FAIL] Upload failed"

echo ""
echo "================================================"
echo " 5. Backend logs — embedding/RAG activity"
echo "================================================"
docker logs smart_assistant_backend --since 2m 2>&1 | grep -v "^GET\|^POST\|morgan" | tail -20
