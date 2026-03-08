#!/bin/bash
TENANT="medihelp-mmg76fsx"
BASE="http://localhost:8000"

echo "=== Threshold env check ==="
docker exec smart_assistant_backend env | grep RAG_RELEVANCE

echo ""
echo "=== Waiting for backend to be ready ==="
for i in $(seq 1 10); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health" 2>/dev/null)
  if [ "$CODE" = "200" ]; then echo "Backend ready"; break; fi
  echo "  attempt $i: code=$CODE, waiting..."
  sleep 3
done

echo ""
echo "=== Testing question variants ==="
QUESTIONS=("do you accept credit cards" "what payment methods do you accept" "how can I pay" "payment options" "what are your store hours")
for Q in "${QUESTIONS[@]}"; do
  RESP=$(curl -s -X POST "$BASE/api/chat/$TENANT" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"$Q\",\"sessionId\":\"thresh-test-$$\"}" 2>/dev/null)
  SOURCE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('knowledgeSource','unknown'))" 2>/dev/null || echo "parse-err")
  MSG=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','')[:120])" 2>/dev/null || echo "$RESP" | head -c 100)
  echo "Q: \"$Q\""
  echo "   source=$SOURCE | $MSG"
  echo ""
done
