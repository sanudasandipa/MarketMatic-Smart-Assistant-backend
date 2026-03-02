/**
 * chromaManager.js
 *
 * Automatically starts ChromaDB as a child process if it isn't already running.
 * Called once during server startup before any route handlers need it.
 *
 * Requires:  pip install chromadb   (the `chroma` CLI must be on PATH or in
 * the standard Python user-scripts location on Windows)
 */
const { spawn, execSync } = require('child_process');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');

const CHROMA_URL   = process.env.CHROMA_URL || 'http://localhost:8001';
const CHROMA_PATH  = path.resolve(__dirname, '../../chroma_data');
const POLL_MS      = 1500;   // how often to check if chroma is up
const MAX_RETRIES  = 20;     // give up after ~30 s

let chromaProcess = null;

/**
 * Try to locate the `chroma` executable.
 * Search order:
 *   1. PATH (via `where` on Windows / `which` on Unix)
 *   2. %APPDATA%\Python\PythonXXX\Scripts\chroma.exe  (pip --user on Windows)
 *   3. Fallback: just 'chroma' and let the OS error out with a clear message
 */
function findChromaExe() {
  // 1. Windows: user-scripts folder  %APPDATA%\Python\PythonXXX\Scripts\chroma.exe
  //    Check this FIRST so we never accidentally pick up node_modules\.bin\chroma
  if (process.platform === 'win32' && process.env.APPDATA) {
    const pyBase = path.join(process.env.APPDATA, 'Python');
    if (fs.existsSync(pyBase)) {
      const versions = fs.readdirSync(pyBase).filter((d) => d.startsWith('Python'));
      for (const ver of versions.sort().reverse()) {
        const candidate = path.join(pyBase, ver, 'Scripts', 'chroma.exe');
        if (fs.existsSync(candidate)) {
          console.log(`[chromaManager] Found Python chroma.exe: ${candidate}`);
          return candidate;
        }
      }
    }
  }

  // 2. System-wide Python Scripts (e.g. C:\ProgramData\miniconda3\Scripts\chroma.exe)
  const globalPyScripts = [
    'C:\\Python311\\Scripts\\chroma.exe',
    'C:\\Python310\\Scripts\\chroma.exe',
    'C:\\Python39\\Scripts\\chroma.exe',
    'C:\\Program Files\\Python311\\Scripts\\chroma.exe',
    'C:\\Program Files\\Python310\\Scripts\\chroma.exe',
  ];
  for (const p of globalPyScripts) {
    if (fs.existsSync(p)) return p;
  }

  // 3. PATH — but explicitly skip anything inside node_modules
  try {
    const cmd = process.platform === 'win32' ? 'where chroma' : 'which chroma';
    const hits = execSync(cmd, { stdio: 'pipe' })
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.includes('node_modules'));
    if (hits.length > 0 && fs.existsSync(hits[0])) return hits[0];
  } catch (_) { /* not on PATH */ }

  // 4. Fallback – let the OS report a clear "not found" error
  return 'chroma';
}

/** Resolve host/port from CHROMA_URL */
function parseChromaUrl() {
  const url  = new URL(CHROMA_URL);
  return { host: url.hostname, port: parseInt(url.port || '8001', 10) };
}

/** Returns true if ChromaDB is already accepting HTTP connections */
function isChromaUp() {
  return new Promise((resolve) => {
    const { host, port } = parseChromaUrl();
    const req = http.get({ host, port, path: '/api/v1/heartbeat', timeout: 2000 }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Poll until ChromaDB is ready or we run out of retries */
async function waitForChroma(retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    if (await isChromaUp()) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/** Spawn the `chroma run` process in the background */
function spawnChroma() {
  const chromaExe = findChromaExe();
  const { port }  = parseChromaUrl();

  console.log(`⚙️   Starting ChromaDB  →  ${chromaExe} run --path ${CHROMA_PATH} --port ${port}`);

  chromaProcess = spawn(chromaExe, ['run', '--path', CHROMA_PATH, '--port', String(port)], {
    shell: true,           // use shell so PATH is searched / .exe is resolved
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,       // keep it tied to this Node process
  });

  chromaProcess.stdout.on('data', (d) => process.stdout.write(`[chroma] ${d}`));
  chromaProcess.stderr.on('data', (d) => process.stderr.write(`[chroma] ${d}`));

  chromaProcess.on('error', (err) => {
    console.error('❌  Failed to spawn ChromaDB process:', err.message);
    console.error('    Make sure chromadb is installed:  pip install chromadb');
  });

  chromaProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`⚠️   ChromaDB process exited (code=${code}, signal=${signal})`);
    }
    chromaProcess = null;
  });

  // Gracefully stop Chroma when Node process exits
  process.on('exit',    () => chromaProcess?.kill());
  process.on('SIGINT',  () => { chromaProcess?.kill(); process.exit(0); });
  process.on('SIGTERM', () => { chromaProcess?.kill(); process.exit(0); });
}

/**
 * Ensure ChromaDB is running.
 * - If already up: logs and returns immediately.
 * - If not up: spawns it, then waits for it to become ready.
 */
async function ensureChroma() {
  if (await isChromaUp()) {
    console.log(`✅  ChromaDB already running at ${CHROMA_URL}`);
    return;
  }

  spawnChroma();

  console.log('⏳  Waiting for ChromaDB to be ready…');
  const ready = await waitForChroma();

  if (ready) {
    console.log(`✅  ChromaDB is ready at ${CHROMA_URL}`);
  } else {
    console.error(`❌  ChromaDB did not become ready within ${(MAX_RETRIES * POLL_MS) / 1000}s.`);
    console.error('    Chat / document features will not work until ChromaDB is running.');
    // Do NOT crash the backend — other routes (auth, admin) still work fine.
  }
}

module.exports = { ensureChroma };
