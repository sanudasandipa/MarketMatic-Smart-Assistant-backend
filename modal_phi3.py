"""
Modal deployment: phi3 via Ollama on GPU
-----------------------------------------
Hosts Ollama with phi3 on a Modal GPU and exposes an HTTP endpoint
that is fully compatible with the Ollama /api/chat REST API.

The Azure VM backend sets OLLAMA_URL to the Modal endpoint URL,
so no code changes are needed — just an env var swap.

Deploy:
  python -m modal deploy modal_phi3.py

After deploy, Modal prints the URL, e.g.:
  https://sanudasandipa2002--phi3-ollama-serve.modal.run

Usage (same as local Ollama):
  POST <URL>/api/chat
  {
    "model": "phi3",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": false
  }
"""

import subprocess
import time
import modal

# ── Modal app definition ──────────────────────────────────────────────────────
app = modal.App("phi3-ollama")

# Use the official Ollama image
ollama_image = (
    modal.Image.from_registry("ollama/ollama:latest", add_python="3.11")
    .pip_install("fastapi[standard]", "httpx")
)

# Persistent volume to cache the phi3 model weights (~2.2GB)
# This avoids re-downloading on every cold start
model_volume = modal.Volume.from_name("ollama-phi3-models", create_if_missing=True)

# ── GPU-backed class ──────────────────────────────────────────────────────────
@app.cls(
    image=ollama_image,
    gpu="T4",               # cheapest GPU on Modal — fast enough for phi3
    volumes={"/root/.ollama": model_volume},
    timeout=300,            # 5 min max per request
    container_idle_timeout=120,  # keep warm for 2 min after last request
    allow_concurrent_inputs=4,
)
class OllamaPhi3:

    @modal.enter()
    def start_ollama(self):
        """Start the Ollama server and pull phi3 on first run."""
        # Start ollama serve in background
        self._proc = subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for server to be ready
        import httpx
        for _ in range(30):
            try:
                httpx.get("http://localhost:11434/api/version", timeout=2)
                break
            except Exception:
                time.sleep(1)

        # Pull phi3 if not already cached in the volume
        result = subprocess.run(
            ["ollama", "pull", "phi3"],
            capture_output=True,
            text=True,
        )
        print("phi3 pull:", result.stdout[-200:] if result.stdout else "already cached")

    @modal.web_endpoint(method="POST", docs=True)
    async def chat(self, request: dict) -> dict:
        """POST /chat — Ollama-compatible /api/chat endpoint."""
        import httpx
        async with httpx.AsyncClient(timeout=200) as client:
            resp = await client.post(
                "http://localhost:11434/api/chat",
                json=request,
            )
            resp.raise_for_status()
            return resp.json()

    @modal.web_endpoint(method="POST", path="/api/chat", docs=True)
    async def api_chat(self, request: dict) -> dict:
        """POST /api/chat — matches Ollama path exactly."""
        return await self.chat(request)

    @modal.web_endpoint(method="GET", path="/api/version", docs=True)
    async def version(self) -> dict:
        """GET /api/version — health/version check."""
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("http://localhost:11434/api/version")
            return resp.json()

    @modal.web_endpoint(method="GET", path="/api/tags", docs=True)
    async def tags(self) -> dict:
        """GET /api/tags — list available models (like ollama list)."""
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("http://localhost:11434/api/tags")
            return resp.json()
