// server.js — HTTP + WebSocket server
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { search, getSongUrl, getPlaylistAllTracks, getSongInfo } from './src/ncm.js';
import { buildContext } from './src/context.js';
import { askClaudio } from './src/claude.js';
import { route } from './src/router.js';
import { synthesize, releaseTts, pruneStaleTts, clearCache } from './src/tts.js';
import { getWeather } from './src/weather.js';
import { savePlay, saveMessage, savePref, getPref, getRecentPlays, getRecentMessages, deletePlay, getPlaysPaginated } from './src/state.js';
import { startScheduler } from './src/scheduler.js';
import { analyzePlaylists, getTasteProfile, matchFromPlaylists } from './src/analyzer.js';
// UPnP helpers loaded dynamically to avoid crash if module is missing
async function _getNaimDevice() {
  try { const m = await import('./src/upnp.js'); return m.getNaimDevice(); } catch { return null; }
}
async function _playOnDevice(device, url) {
  try { const m = await import('./src/upnp.js'); return m.playOnDevice(device, url); } catch { return false; }
}
async function _discoverDevices() {
  try { const m = await import('./src/upnp.js'); return m.discoverDevices(); } catch { return []; }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const NCM_BASE = process.env.NCM_BASE || 'http://localhost:3000';
const NCM_COOKIE = process.env.NCM_COOKIE || '';
const HISTORY_PLAY_LIMIT = Math.max(1, Number(process.env.UI_HISTORY_PLAY_LIMIT || 100));
const HISTORY_MESSAGE_LIMIT = Math.max(1, Number(process.env.UI_HISTORY_MESSAGE_LIMIT || 50));

const app = express();
const httpServer = createServer(app);

// JSON body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Disable all caching during development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Static files
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/pwa', express.static(join(__dirname, 'pwa'), { etag: false, lastModified: false }));
app.use('/tts', express.static(join(__dirname, 'cache', 'tts')));

// Root route - serve PWA
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'pwa', 'index.html'));
});

// WebSocket
const wss = new WebSocketServer({ server: httpServer, path: '/stream' });
const clients = new Set();

export function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

async function buildSayPayload(text, options = {}) {
  const { autoStartMusic = false } = options;
  let tts = null;
  try {
    tts = await synthesize(text);
  } catch (e) {
    console.warn('[server] TTS failed:', e.message);
  }

  return {
    text,
    audio: tts?.publicUrl || null,
    ttsId: tts?.id || null,
    autoStartMusic
  };
}

async function buildNowPlayingPayload(song, url, dbId) {
  const meta = (!song?.cover || !song?.album) && song?.id
    ? await getSongInfo(song.id)
    : { album: song?.album || '', cover: song?.cover || '' };

  return {
    name: song?.name || 'Unknown',
    artist: song?.artist || 'Unknown',
    album: meta.album || song?.album || '',
    cover: meta.cover || song?.cover || '',
    url,
    id: song?.id || '',
    dbId
  };
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ event: 'connected', data: { version: '0.1.0' }, ts: Date.now() }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[ws-server] received:', msg.event);
      if (msg.event === 'manual-play' && msg.data?.name) {
        const { name, artist } = msg.data;
        console.log('[ws-server] manual-play for:', name, artist);
        const ctx = buildContext({ userInput: `用户正在听《${name}》${artist ? ' - ' + artist : ''}。请作为DJ介绍这首歌：说说歌手是谁、这首歌的创作背景或故事、歌曲的风格和感觉。大约10秒的篇幅（50-80字），自然口语，像在跟朋友分享一首好歌。不要用"推荐""希望你喜欢"这类词。`, env: { now: new Date().toLocaleString('zh-CN'), weather: '未知', events: [] }, trace: 'manual-play' });
        const result = await askClaudio(ctx.user, ctx.system);
        console.log('[ws-server] askClaudio result:', result?.say ? 'OK' : 'FALLBACK');
        if (result?.say) broadcast('say', await buildSayPayload(result.say));
      }
    } catch(e) { console.error('[ws-server] error:', e.message); }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// --- Routes ---

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message, silent } = req.body;
    if (!message) return res.json({ ok: false, error: 'message required' });

    const intent = route(message);

    if (intent === 'music') {
      // Direct music search + play
      const results = await search(message, 3);
      if (results.length === 0) {
        broadcast('error', { text: 'No results found' });
        return res.json({ ok: true, say: '没找到这首歌', play: [], reason: 'search_empty' });
      }

      const song = results[0];
      const url = await getSongUrl(song.id);
      const dbId = savePlay(song.name, song.artist, String(song.id), 'direct_search');
      broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
      saveMessage('user', message);
      saveMessage('assistant', `播放 ${song.name} - ${song.artist}`);

      return res.json({ ok: true, say: `播放 ${song.name}`, play: [`${song.name} - ${song.artist}`], reason: 'direct_search' });
    }

    if (intent === 'direct') {
      saveMessage('user', message);

      // Weather query
      if (/天气/.test(message)) {
        const w = await getWeather();
        const say = `现在天气：${w.text}，温度 ${w.temp}°C，湿度 ${w.humidity}%，风向 ${w.windDir}。更新于 ${w.updateTime}`;
        saveMessage('assistant', say);
        return res.json({ ok: true, say, play: [], reason: 'weather' });
      }

      // Calendar / today query
      if (/日历|今天有什么/.test(message)) {
        let events = [];
        try { events = JSON.parse(getPref('today_events') || '[]'); } catch {}
        if (events.length === 0) {
          const say = '今天没有日程安排。';
          saveMessage('assistant', say);
          return res.json({ ok: true, say, play: [], reason: 'calendar' });
        }
        const say = '今日日程：\n' + events.map(e => `- ${e}`).join('\n');
        saveMessage('assistant', say);
        return res.json({ ok: true, say, play: [], reason: 'calendar' });
      }

      // Time query
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const say = `现在是 ${now}`;
      saveMessage('assistant', say);
      return res.json({ ok: true, say, play: [], reason: 'time' });
    }

    // Claude route
    const now = new Date().toLocaleString('zh-CN');

    // Fetch weather and calendar in parallel
    const [weatherResult, eventsRaw] = await Promise.all([
      getWeather(),
      Promise.resolve().then(() => {
        try { return JSON.parse(getPref('today_events') || '[]'); }
        catch { return []; }
      })
    ]);

    const weather = `${weatherResult.text} ${weatherResult.temp}°C`;

    const ctx = buildContext({
      userInput: message,
      env: { now, weather, events: eventsRaw },
      trace: ''
    });

    const result = await askClaudio(ctx.user, ctx.system);

    if (!silent) broadcast('say', await buildSayPayload(result.say, { autoStartMusic: (result.play?.length || 0) > 0 }));

    // Process play list — try playlist matching first, fall back to search
    let playedCount = 0;
    for (const songStr of result.play) {
      let song = null;
      let url = null;

      // First: try matching from user's own playlists
      const matches = matchFromPlaylists(songStr);
      if (matches.length > 0) {
        song = matches[0];
        url = await getSongUrl(song.id);
      }

      // Fallback: global search
      if (!song || !url) {
        const results = await search(songStr, 1);
        if (results.length > 0) {
          song = results[0];
          url = await getSongUrl(song.id);
        }
      }

      if (song) {
        const dbId = savePlay(song.name, song.artist, String(song.id), result.reason);
        broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
        playedCount++;

        // Fire-and-forget Naim push
        if (url) {
          _getNaimDevice().then(device => {
            if (device) _playOnDevice(device, url).catch(() => {});
          }).catch(() => {});
        }
      }
    }

    if (result.segue) {
      broadcast('segue', { text: result.segue });
    }

    saveMessage('user', message);
    saveMessage('assistant', result.say);

    res.json({ ok: true, say: result.say, play: result.play, reason: result.reason });
  } catch (e) {
    console.error('[server] /api/chat error:', e);
    broadcast('error', { text: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/now
app.get('/api/now', (req, res) => {
  try {
    const plays = getRecentPlays(1);
    res.json(plays[0] || {});
  } catch (e) {
    res.json({});
  }
});

// GET /api/song/:id/url
app.get('/api/song/:id/url', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.json({ ok: false, error: 'id required' });

    const url = await getSongUrl(id);
    if (!url) return res.json({ ok: false, error: 'url unavailable' });

    res.json({ ok: true, id, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/song/:id/meta
app.get('/api/song/:id/meta', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.json({ ok: false, error: 'id required' });

    const meta = await getSongInfo(id);
    res.json({ ok: true, id, album: meta.album || '', cover: meta.cover || '' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/ncm/lyric — fetch lyrics from Netease (by id or keyword search)
app.get('/api/ncm/lyric', async (req, res) => {
  try {
    let id = String(req.query.id || '').trim();
    const keyword = String(req.query.keyword || '').trim();

    // ID takes priority (same version as audio). Only search if no ID.
    if (!id && keyword) {
      const searchResp = await fetch(`${NCM_BASE}/search?keywords=${encodeURIComponent(keyword)}&limit=3&cookie=${encodeURIComponent(NCM_COOKIE)}`);
      const searchData = await searchResp.json();
      const songs = searchData.result?.songs || [];
      if (songs.length > 0) id = String(songs[0].id);
    }

    if (!id) return res.json({ ok: false, error: 'id required' });
    console.log('[lyric-server] fetching lyric for id=' + id + (keyword ? ' keyword=' + keyword : ''));
    const resp = await fetch(`${NCM_BASE}/lyric?id=${encodeURIComponent(id)}&cookie=${encodeURIComponent(NCM_COOKIE)}`);
    const data = await resp.json();
    res.json({ ok: true, lrc: data.lrc || {}, tlyric: data.tlyric || {} });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/tts/:id/complete
app.post('/api/tts/:id/complete', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.json({ ok: false, error: 'id required' });

    const status = String(req.body?.status || req.query?.status || 'completed').trim() || 'completed';
    const result = releaseTts(id, status);
    if (!result.ok) return res.json({ ok: false, error: 'tts not found' });

    res.json({ ok: true, scheduled: result.scheduled, delayMs: result.delayMs || 0 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const plays = getRecentPlays(HISTORY_PLAY_LIMIT).reverse();
    const messages = getRecentMessages(HISTORY_MESSAGE_LIMIT).reverse();

    const playHistory = await Promise.all(plays.map(async (play) => {
      let url = null;
      if (play.ncm_id) {
        try {
          url = await getSongUrl(play.ncm_id);
        } catch {}
      }

      return {
        id: play.id,
        name: play.song_name,
        artist: play.artist,
        ncmId: play.ncm_id,
        reason: play.reason,
        ts: play.ts,
        url
      };
    }));

    res.json({
      ok: true,
      plays: playHistory,
      messages: messages.map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        ts: msg.ts
      }))
    });
  } catch (e) {
    res.json({ ok: false, plays: [], messages: [], error: e.message });
  }
});

// DELETE /api/play/:id
app.delete('/api/play/:id', (req, res) => {
  try {
    const result = deletePlay(req.params.id);
    res.json({ ok: true, deleted: result.changes > 0 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/plays — paginated play history
app.get('/api/plays', (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { total, rows } = getPlaysPaginated(limit, offset);
    res.json({ ok: true, total, limit, offset, plays: rows });
  } catch (e) {
    res.json({ ok: false, plays: [], error: e.message });
  }
});

// POST /api/refill — auto-refill when queue exhausted
app.post('/api/refill', async (req, res) => {
  try {
    const now = new Date().toLocaleString('zh-CN');
    const weatherResult = await getWeather();
    const weather = `${weatherResult.text} ${weatherResult.temp}°C`;
    let events = [];
    try { events = JSON.parse(getPref('today_events') || '[]'); } catch {}

    const ctx = buildContext({
      userInput: '播放列表播完了，请以DJ Claudio的身份说一句话并推荐几首歌继续播放',
      env: { now, weather, events },
      trace: '队列播完自动续播'
    });
    const result = await askClaudio(ctx.user, ctx.system);

    if (result.play && result.play.length > 0) {
      broadcast('say', await buildSayPayload(result.say, { autoStartMusic: true }));
      for (const songStr of result.play) {
        let song = null;
        let url = null;

        const matches = matchFromPlaylists(songStr);
        if (matches.length > 0) {
          song = matches[0];
          url = await getSongUrl(song.id);
        }
        if (!song || !url) {
          const results = await search(songStr, 1);
          if (results.length > 0) {
            song = results[0];
            url = await getSongUrl(song.id);
          }
        }

        if (song) {
          const dbId = savePlay(song.name, song.artist, String(song.id), result.reason || 'queue_refill');
          broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
        }
      }
    }

    res.json({ ok: true, count: result.play?.length || 0 });
  } catch (e) {
    console.error('[refill] error:', e);
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/next
app.get('/api/next', (req, res) => {
  try {
    const plan = JSON.parse(getPref('today_plan') || '{}');
    res.json(plan.play?.[0] || null);
  } catch {
    res.json(null);
  }
});

// GET /api/taste
app.get('/api/taste', (req, res) => {
  try {
    const userDir = join(__dirname, 'user');
    const files = readdirSync(userDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, content: readFileSync(join(userDir, f), 'utf-8') }));
    res.json({ files });
  } catch (e) {
    res.json({ files: [] });
  }
});

// GET /api/plan/today
app.get('/api/plan/today', (req, res) => {
  try {
    const plan = JSON.parse(getPref('today_plan') || '{}');
    res.json(plan);
  } catch {
    res.json({});
  }
});

// POST /api/plan/today — generate today's playlist on demand
app.post('/api/plan/today', async (req, res) => {
  try {
    const now = new Date().toLocaleString('zh-CN');
    const weatherResult = await getWeather();
    const weather = `${weatherResult.text} ${weatherResult.temp}°C`;
    let events = [];
    try { events = JSON.parse(getPref('today_events') || '[]'); } catch {}

    const ctx = buildContext({
      userInput: '请根据当前时间、天气和我的口味，生成一份今日歌单，推荐10首歌',
      env: { now, weather, events },
      trace: '手动今日歌单'
    });
    const result = await askClaudio(ctx.user, ctx.system);

    savePref('today_plan', JSON.stringify(result));

    const songs = (result.play || []).slice(0, 10);

    if (songs.length > 0) {
      broadcast('say', await buildSayPayload(result.say, { autoStartMusic: true }));
      for (const songStr of songs) {
        let song = null;
        let url = null;

        const matches = matchFromPlaylists(songStr);
        if (matches.length > 0) {
          song = matches[0];
          url = await getSongUrl(song.id);
        }
        if (!song || !url) {
          const results = await search(songStr, 1);
          if (results.length > 0) {
            song = results[0];
            url = await getSongUrl(song.id);
          }
        }

        if (song) {
          const dbId = savePlay(song.name, song.artist, String(song.id), result.reason || 'today_plan');
          broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
        }
      }
    }

    res.json({ ok: true, count: songs.length });
  } catch (e) {
    console.error('[plan/today] error:', e);
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /api/playlists — list configured playlists with track counts
app.get('/api/playlists', async (req, res) => {
  try {
    const path = join(__dirname, 'user', 'playlists.json');
    const config = JSON.parse(readFileSync(path, 'utf-8'));
    const { uid, playlists } = config;

    if (!playlists || playlists.length === 0) {
      return res.json({ uid: uid || '', playlists: [], message: '请在 user/playlists.json 中添加歌单 ID' });
    }

    // Enrich with track counts (fetch if needed)
    const enriched = [];
    for (const pl of playlists) {
      try {
        const tracks = await getPlaylistAllTracks(pl.id);
        enriched.push({ ...pl, trackCount: tracks.length });
      } catch {
        enriched.push(pl);
      }
    }

    res.json({ uid: uid || '', playlists: enriched });
  } catch (e) {
    res.json({ uid: '', playlists: [], error: e.message });
  }
});

// POST /api/analyze — trigger playlist analysis manually
app.post('/api/analyze', async (req, res) => {
  try {
    const result = await analyzePlaylists();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/analysis — get cached analysis result
app.get('/api/analysis', (req, res) => {
  try {
    const profile = getTasteProfile();
    const topArtists = JSON.parse(getPref('taste_top_artists') || '[]');
    const songs = JSON.parse(getPref('playlist_songs') || '[]');
    res.json({ profile, topArtists, songCount: songs.length });
  } catch (e) {
    res.json({ profile: null, topArtists: [], songCount: 0 });
  }
});

// UPnP routes
app.get('/api/upnp/devices', async (req, res) => {
  try {
    const devices = await _discoverDevices();
    res.json({ devices });
  } catch (e) {
    res.json({ devices: [] });
  }
});

app.post('/api/upnp/play', async (req, res) => {
  try {
    const { url, deviceName } = req.body;
    if (!url) return res.json({ ok: false, error: 'url required' });

    let device = null;
    if (deviceName) {
      const devices = await _discoverDevices();
      device = devices.find(d => d.friendlyName.includes(deviceName));
    } else {
      device = await _getNaimDevice();
    }

    if (!device) return res.json({ ok: false, error: 'device not found' });

    const ok = await _playOnDevice(device, url);
    res.json({ ok, device: device.friendlyName });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Start
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`Claudio running on http://localhost:${PORT}`);
  try { startScheduler(); } catch {}
  const staleDeleted = pruneStaleTts();
  const legacyDeleted = clearCache(1);
  if (staleDeleted > 0 || legacyDeleted > 0) {
    console.log(`[tts] Cleanup on start: stale=${staleDeleted}, legacy=${legacyDeleted}`);
  }
  setInterval(() => {
    const deleted = pruneStaleTts();
    if (deleted > 0) console.log(`[tts] Periodic stale cleanup: ${deleted}`);
  }, 300000).unref();

  // Run initial playlist analysis (non-blocking, fire-and-forget)
  analyzePlaylists().then(r => {
    console.log(`[server] Initial playlist analysis: ${r.totalSongs} songs`);
  }).catch(e => {
    console.warn('[server] Initial playlist analysis skipped:', e.message);
  });
});
