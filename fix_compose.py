"""Fix docker-compose.yml to use Modal Ollama URL from .env instead of hardcoded local."""
import sys

path = '/home/azureuser/smart-assistant/docker-compose.yml'

with open(path, 'r') as f:
    content = f.read()

# 1. Change hardcoded OLLAMA_URL to use .env value with fallback
old1 = '      OLLAMA_URL: http://ollama:11434'
new1 = '      OLLAMA_URL: ${OLLAMA_URL:-http://ollama:11434}'
if old1 in content:
    content = content.replace(old1, new1)
    print('Fixed OLLAMA_URL')
else:
    print('WARN: OLLAMA_URL line not found as expected')

# 2. Update OLLAMA_TIMEOUT_MS default
old2 = '      OLLAMA_TIMEOUT_MS: ${OLLAMA_TIMEOUT_MS:-60000}'
new2 = '      OLLAMA_TIMEOUT_MS: ${OLLAMA_TIMEOUT_MS:-200000}'
if old2 in content:
    content = content.replace(old2, new2)
    print('Fixed OLLAMA_TIMEOUT_MS')
else:
    print('WARN: OLLAMA_TIMEOUT_MS line not found as expected')

# 3. Update RAG_RELEVANCE_THRESHOLD default
old3 = '      RAG_RELEVANCE_THRESHOLD: ${RAG_RELEVANCE_THRESHOLD:-0.65}'
new3 = '      RAG_RELEVANCE_THRESHOLD: ${RAG_RELEVANCE_THRESHOLD:-0.50}'
if old3 in content:
    content = content.replace(old3, new3)
    print('Fixed RAG_RELEVANCE_THRESHOLD')
else:
    print('WARN: RAG_RELEVANCE_THRESHOLD line not found as expected')

with open(path, 'w') as f:
    f.write(content)

print('Done - docker-compose.yml updated')
