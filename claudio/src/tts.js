// src/tts.js — TTS synthesis with Edge TTS + Fish Audio dual engine
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { basename, join, dirname } from 'path';
import { existsSync, unlinkSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'cache', 'tts');
const DELETE_DELAY_MS = Math.max(5000, Number(process.env.TTS_DELETE_DELAY_MS || 10000));
const ORPHAN_MAX_AGE_MS = Math.max(60000, Number(process.env.TTS_ORPHAN_MAX_AGE_MS || 1800000));
const liveTts = new Map();

function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function createTtsId(engine) {
  return `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}-${engine}`;
}

function outPath(ttsId) {
  return join(CACHE_DIR, `${ttsId}.mp3`);
}

function toPublicUrl(filePath) {
  return '/tts/' + basename(filePath);
}

function hydrateTtsFromDisk(id) {
  const filePath = outPath(id);
  if (!existsSync(filePath)) return null;

  const entry = {
    id,
    engine: id.split('-').pop() || 'unknown',
    filePath,
    publicUrl: toPublicUrl(filePath),
    createdAt: statSync(filePath).mtimeMs,
    cleanupTimer: null,
    releaseReason: null
  };
  liveTts.set(id, entry);
  return entry;
}

function getTtsEntry(id) {
  return liveTts.get(id) || hydrateTtsFromDisk(id);
}

function registerTts(filePath, engine) {
  const id = basename(filePath, '.mp3');
  const entry = {
    id,
    engine,
    filePath,
    publicUrl: toPublicUrl(filePath),
    createdAt: Date.now(),
    cleanupTimer: null,
    releaseReason: null
  };
  liveTts.set(id, entry);
  return entry;
}

function normalizeEngine(engine) {
  const value = String(engine || '').trim().toLowerCase();
  return ['edge', 'fish', 'volc', 'dashscope', 'auto'].includes(value) ? value : 'auto';
}

function hasVolcConfig() {
  return Boolean(process.env.VOLC_APP_ID && process.env.VOLC_TOKEN && process.env.VOLC_VOICE_ID);
}

function getFishReferenceId() {
  return process.env.FISH_REFERENCE_ID
    || process.env.FISH_MODEL_ID
    || process.env.FISH_VOICE_ID
    || '';
}

function hasFishConfig() {
  return Boolean(process.env.FISH_API_KEY && getFishReferenceId());
}

// -- Edge TTS ----------------------------------------------------------------
async function synthesizeEdge(text, outFile) {
  // Escape double quotes in text for command line
  const safeText = text.replace(/"/g, '\\"');
  return new Promise((resolve, reject) => {
    // Use the module entrypoint so uv resolves the package from the env
    // even if the console script wrapper in .venv has a stale shebang.
    const cmd = 'D:\\anaconda\\python.exe';
    const args = [
      '-m',
      'edge_tts',
      '--text', safeText,
      '--voice', 'zh-CN-XiaoxiaoNeural',
      '--write-media', outFile
    ];

    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      if (code === 0 && existsSync(outFile)) {
        resolve();
      } else {
        reject(new Error(`edge-tts failed (uv run python -m edge_tts) code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`uv run edge-tts failed to spawn: ${err.message}`));
    });
  });
}

// -- Fish Audio ----------------------------------------------------------------
async function synthesizeFish(text, outFile) {
  const apiKey = process.env.FISH_API_KEY;
  const referenceId = getFishReferenceId();
  if (!apiKey) throw new Error('FISH_API_KEY not configured');
  if (!referenceId) throw new Error('FISH_REFERENCE_ID not configured');

  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'model': process.env.FISH_MODEL || 's2-pro'
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: 'mp3',
      latency: 'normal'
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Fish Audio HTTP ${res.status}: ${detail}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outFile, buffer);
}

// -- 火山引擎 TTS (Voice Cloning) --------------------------------------------
async function synthesizeVolc(text, outFile) {
  const appId = process.env.VOLC_APP_ID;
  const token = process.env.VOLC_TOKEN;
  const voiceId = process.env.VOLC_VOICE_ID;
  if (!appId || !token || !voiceId) throw new Error('VOLC_APP_ID/VOLC_TOKEN/VOLC_VOICE_ID not configured');

  const { randomUUID } = await import('crypto');
  const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer;${token}`,
    },
    body: JSON.stringify({
      app: { appid: appId },
      user: { uid: 'claudio_user' },
      audio: { format: 'mp3', voice_type: voiceId, sample_rate: 24000 },
      request: { reqid: randomUUID(), text, volume: 1.0, speed: 0.95, operation: 'submit' },
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Volcengine HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  if (data.code === 3000 && data.data?.audio) {
    writeFileSync(outFile, Buffer.from(data.data.audio, 'base64'));
  } else if (data.audio) {
    writeFileSync(outFile, Buffer.from(data.audio, 'base64'));
  } else {
    throw new Error(`Volcengine error: ${JSON.stringify(data)}`);
  }
}

// -- DashScope (Alibaba Qwen TTS) --------------------------------------------
async function synthesizeDashScope(text, outFile) {
  const safeText = text.replace(/"/g, '\\"');
  return new Promise((resolve, reject) => {
    const child = spawn('D:\\anaconda\\python.exe', [
      'tts_dashscope.py', safeText, outFile
    ], { cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      if (code === 0 && stdout.includes('OK') && existsSync(outFile)) resolve();
      else reject(new Error(`dashscope code ${code}: ${stdout}`));
    });
    child.on('error', (err) => reject(new Error(`dashscope spawn: ${err.message}`)));
  });
}

// -- Main API ----------------------------------------------------------------
async function synthesizeWithEngine(text, engine) {
  ensureCacheDir();
  const file = outPath(createTtsId(engine));

  if (engine === 'fish') { await synthesizeFish(text, file); return registerTts(file, engine); }
  if (engine === 'volc') { await synthesizeVolc(text, file); return registerTts(file, engine); }
  if (engine === 'dashscope') { await synthesizeDashScope(text, file); return registerTts(file, engine); }

  await synthesizeEdge(text, file);
  return registerTts(file, engine);
}

export async function synthesize(text, engine) {
  const selectedEngine = normalizeEngine(engine || process.env.TTS_ENGINE || 'auto');

  if (selectedEngine !== 'auto') return synthesizeWithEngine(text, selectedEngine);

  // auto: dashscope > volc > fish > edge
  try { return await synthesizeWithEngine(text, 'dashscope'); }
  catch (e) { console.warn('[tts] DashScope failed:', e.message); }

  if (hasVolcConfig()) {
    try { return await synthesizeWithEngine(text, 'volc'); }
    catch (e) { console.warn('[tts] Volc failed:', e.message); }
  }
  if (hasFishConfig()) {
    try { return await synthesizeWithEngine(text, 'fish'); }
    catch (e) { console.warn('[tts] Fish failed:', e.message); }
  }
  return synthesizeWithEngine(text, 'edge');
}

// -- Cache management ---------------------------------------------------------
function deleteTtsFile(id) {
  const entry = getTtsEntry(id);
  if (!entry) return false;

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }

  try {
    if (existsSync(entry.filePath)) unlinkSync(entry.filePath);
  } catch {}

  liveTts.delete(id);
  return true;
}

export function releaseTts(id, reason = 'completed', options = {}) {
  const entry = getTtsEntry(id);
  if (!entry) return { ok: false, scheduled: false };

  entry.releaseReason = reason;

  if (options.immediate) {
    return { ok: deleteTtsFile(id), scheduled: false };
  }

  if (!entry.cleanupTimer) {
    entry.cleanupTimer = setTimeout(() => {
      deleteTtsFile(id);
    }, DELETE_DELAY_MS);
    if (typeof entry.cleanupTimer.unref === 'function') entry.cleanupTimer.unref();
  }

  return { ok: true, scheduled: true, delayMs: DELETE_DELAY_MS };
}

export function pruneStaleTts(maxAgeMs = ORPHAN_MAX_AGE_MS) {
  ensureCacheDir();
  const cutoff = Date.now() - Math.max(60000, maxAgeMs);
  let deleted = 0;

  try {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.mp3'));
    for (const f of files) {
      const full = join(CACHE_DIR, f);
      if (statSync(full).mtimeMs < cutoff) {
        try { unlinkSync(full); deleted++; } catch {}
        liveTts.delete(basename(f, '.mp3'));
      }
    }
  } catch {}

  return deleted;
}

export function clearCache(olderThanDays = 7) {
  ensureCacheDir();
  const now = Date.now();
  const cutoff = now - olderThanDays * 86400000;
  let deleted = 0;

  try {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.mp3'));
    for (const f of files) {
      const full = join(CACHE_DIR, f);
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        deleted++;
      }
    }
  } catch {}

  return deleted;
}

// TEST: node src/tts.js
if (process.argv[1]?.endsWith('/src/tts.js') || process.argv[1]?.endsWith('\\src\\tts.js')) {
  console.log('[tts] Self-test: synthesizing "今天是个好天气" with edge...');
  synthesize('今天是个好天气', 'edge')
    .then(result => {
      console.log('[tts] Output:', result.filePath);
      const stat = statSync(result.filePath);
      console.log('[tts] Size:', stat.size, 'bytes');
    })
    .catch(e => console.error('[tts] Test failed:', e.message));
}
