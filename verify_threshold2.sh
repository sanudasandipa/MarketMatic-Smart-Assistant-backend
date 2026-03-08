#!/bin/bash
TENANT="medihelp-mmg76fsx"
BASE="http://localhost:8000"

echo "=== Threshold env check ==="
docker exec smart_assistant_backend env | grep RAG_RELEVANCE

echo ""
echo "=== Testing question variants ==="

test_question() {
  local Q="$1"
  local BODY=$(printf '{"message":"%s","tenantId":"%s","sessionId":"vtest-1"}' "$Q" "$TENANT")
  local RESP=$(curl -s -X POST "$BASE/api/chat" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>/dev/null)
  local SOURCE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('knowledgeSource','?'))" 2>/dev/null)
  local MSG=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','')[:120])" 2>/dev/null)
  echo "Q: \"$Q\""
  echo "   [source=$SOURCE] $MSG"
  echo ""
}

test_question "do you accept credit cards"
test_question "what payment methods do you accept"
test_question "how can I pay"
test_question "payment options"
test_question "what are your store hours"
