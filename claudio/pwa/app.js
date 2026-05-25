// app.js — Claudio FM frontend
// ============================================================

// ---- DOM refs ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Clock
const clockEl = $('#clock');
const weekdayEl = $('#weekday');
const dateEl = $('#date');
const onAirDot = $('#on-air-dot');
const chatDot = $('#chat-dot');

// Player
const eqBars = $('#eq-bars');
const trackCover = $('#track-cover');
const trackCoverFallback = $('#track-cover-fallback');
const trackName = $('#track-name');
const trackArtist = $('#track-artist');
const trackAlbum = $('#track-album');
const trackStatus = $('#track-status');
const btnPrev = $('#btn-prev');
const btnPlay = $('#btn-play');
const iconPlay = $('#icon-play');
const iconPause = $('#icon-pause');
const btnNext = $('#btn-next');
const btnStop = $('#btn-stop');
const btnHideVol = $('#btn-hide-vol');
const volWrap = $('#vol-wrap');
const volSlider = $('#vol-slider');
const timeElapsed = $('#time-elapsed');
const timeTotal = $('#time-total');
const progressTrack = $('#progress-track');
const progressFill = $('#progress-fill');

// Queue
const queueList = $('#queue-list');
const queueCount = $('#queue-count');
const queueHeader = $('.queue-header');
const queueSection = $('.queue-section');
const btnQueueClear = $('#btn-queue-clear');
let queueCollapsed = false;

// Chat
const chatMessages = $('#chat-messages');
const chatWelcome = $('#chat-welcome');
const chatInput = $('#chat-input');
const chatHeader = $('.chat-header');
const chatSection = $('.chat-section');
const btnSend = $('#btn-send');
const connBanner = $('#conn-banner');
const btnPlanToday = $('#btn-plan-today');
let chatCollapsed = false;

// Settings
const overlayBackdrop = $('#overlay-backdrop');
const settingsPanel = $('#settings-panel');
const settingsStatus = $('#settings-status');
const settingsUptime = $('#settings-uptime');
const tasteFiles = $('#taste-files');
const tasteLoading = $('#taste-loading');
const btnInstall = $('#btn-install');

// Flip / History
const btnRecord = $('#btn-record');
const flipContainer = $('#flip-container');
const flipInner = $('#flip-inner');
const flipFront = $('.flip-front');
const historyList = $('#history-list');
const btnClearAll = $('#btn-clear-all');

// Audio
const audioMain = $('#audio-main');
const audioTts = $('#audio-tts');
const AUDIO_UNLOCK_SRC = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

// ---- State ----
let ws = null;
let reconnectTimer = null;
let isSending = false;
let welcomeHidden = false;
let playlist = [];
let playlistIndex = -1;
let volume = 0.8;
let duration = 0;
let showVolume = true;
let isPlaying = false;
let messages = [];
let isRecoveringPlayback = false;
let currentTts = null;
let pendingIncomingMusicAutostart = false;
let mediaUnlocked = false;
let mediaUnlockPromise = null;

// ── Lyrics ──
let lyricTimes = [], lyricContainer = null, lyricAbort = null;
async function fetchLyricsForTrack(track) {
  if (!track || (!track.id && !track.name)) return;
  // Set current song for per-song offset
  currentLyricSongId = track.name || '';
  // Cancel previous fetch
  if (lyricAbort) lyricAbort.abort();
  lyricAbort = new AbortController();
  // Remove old container
  if (lyricContainer) { lyricContainer.remove(); lyricContainer = null; }
  lyricTimes = [];
  try {
    console.log('[lyric] track.id=' + track.id + ' name=' + track.name + ' artist=' + track.artist);
    // Use track.id first (same version as audio), fall back to name search
    let url = '/api/ncm/lyric?';
    if (track.id) url += 'id=' + track.id + '&keyword=' + encodeURIComponent(track.name || '');
    else url += 'keyword=' + encodeURIComponent(track.name || '');
    const resp = await fetch(url, { signal: lyricAbort.signal });
    const data = await resp.json();
    const lrc = (data.lrc && data.lrc.lyric) || '';
    if (!lrc.trim()) return;
    // Parse offset
    let offset = 0;
    const offMatch = lrc.match(/\[offset:(-?\d+)\]/);
    if (offMatch) offset = parseInt(offMatch[1]) / 1000;
    const items = [];
    for (const l of lrc.split('\n')) {
      const m = l.match(/\[(\d+):(\d+)(?:[\.:](\d+))?(?:-\d+)?\](.*)/);
      if (!m) continue;
      const t = (m[4] || '').trim();
      if (!t) continue;
      // Skip metadata lines (credits)
      if (/^[作词作曲编曲制作人录音混音吉他贝斯鼓键盘弦乐和声演唱出品发行监制原唱翻唱]/i.test(t)) continue;
      const sec = parseInt(m[1]) * 60 + parseInt(m[2]);
      let frac = 0;
      if (m[3]) {
        const f = parseInt(m[3]);
        frac = m[3].length >= 3 ? f / 1000 : f / 100;
      }
      items.push({ time: sec + frac + offset, text: t });
    }
    if (items.length === 0) return;
    lyricContainer = document.createElement('div');
    lyricContainer.id = 'lyric-overlay';
    lyricContainer.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:100;background:transparent;padding:40px 20px 24px;max-height:220px;overflow-y:scroll;pointer-events:auto;text-align:center';
    lyricContainer.innerHTML = items.map((it, i) => `<div class="lyric-line" data-time="${it.time}" style="padding:2px 0;font-size:13px;color:rgba(255,255,255,.4);text-align:center" id="lr-${i}">${it.text}</div>`).join('');
    document.body.appendChild(lyricContainer);
    lyricTimes = items.map(it => it.time);
    lyricContainer.addEventListener('dblclick', e => {
      const line = e.target.closest('.lyric-line');
      if (line && line.dataset.time) { audioMain.currentTime = Math.max(0, parseFloat(line.dataset.time) - 0.2); audioMain.play().catch(() => {}); }
    });
  } catch(e) {}
}
let lyricAccent = '255,255,255';
function extractLyricColor(coverUrl, fallbackName) {
  lyricAccent = '255,255,255';
  // Generate fallback color from song name
  if (fallbackName) {
    let h = 0; for (let i = 0; i < fallbackName.length; i++) h = (h * 31 + fallbackName.charCodeAt(i)) % 360;
    // Convert HSL to RGB
    const s = 0.8, l = 0.75;
    const c = (1 - Math.abs(2*l - 1)) * s;
    const x = c * (1 - Math.abs((h/60) % 2 - 1));
    const m = l - c/2;
    let r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    lyricAccent = `${Math.round((r+m)*255)},${Math.round((g+m)*255)},${Math.round((b+m)*255)}`;
  }
  // Try album cover — sample center for dominant color
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = 10; c.height = 10;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 10, 10);
      // Sample multiple points, find brightest
      const data = ctx.getImageData(0, 0, 10, 10).data;
      let bestR = 255, bestG = 255, bestB = 255, bestBright = -1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        // Skip very dark pixels
        if (r + g + b < 60) continue;
        // Prefer saturated colors
        const maxC = Math.max(r,g,b), minC = Math.min(r,g,b);
        const sat = maxC - minC;
        const bright = (r + g + b) / 3;
        const score = sat * 2 + bright;
        if (score > bestBright) { bestBright = score; bestR = r; bestG = g; bestB = b; }
      }
      if (bestBright > 0) {
        // Boost brightness
        const boost = (s) => Math.min(255, Math.round(s * 1.4));
        lyricAccent = `${boost(bestR)},${boost(bestG)},${boost(bestB)}`;
      }
    } catch(e) {}
  };
  img.src = coverUrl.replace(/^http:/, 'https:');
}

let currentLyricSongId = null;
let lyricOffsets = {}; // per-song offsets stored in memory
try { lyricOffsets = JSON.parse(localStorage.getItem('lyric_offsets') || '{}'); } catch(e) {}

function saveLyricOffsets() { localStorage.setItem('lyric_offsets', JSON.stringify(lyricOffsets)); }

window.addEventListener('keydown', (e) => {
  if (!currentLyricSongId || lyricTimes.length === 0) return;
  let step = 0.2;
  if (e.ctrlKey || e.metaKey) step = 1.0;
  if (e.shiftKey) step = 0.5;
  if (e.key === 'ArrowLeft') { lyricOffsets[currentLyricSongId] = (lyricOffsets[currentLyricSongId] || 0) - step; saveLyricOffsets(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { lyricOffsets[currentLyricSongId] = (lyricOffsets[currentLyricSongId] || 0) + step; saveLyricOffsets(); e.preventDefault(); }
  console.log('[lyric-offset]', currentLyricSongId, lyricOffsets[currentLyricSongId]);
});

audioMain.addEventListener('timeupdate', () => {
  if (lyricTimes.length === 0) return;
  const perSongOffset = (currentLyricSongId && lyricOffsets[currentLyricSongId]) || 0;
  const t = audioMain.currentTime - 0.15 + perSongOffset;
  let active = -1;
  for (let i = 0; i < lyricTimes.length; i++) { if (t >= lyricTimes[i]) active = i; else break; }
  // When no line matched yet, highlight the first upcoming line
  if (active < 0 && lyricTimes.length > 0) active = 0;
  document.querySelectorAll('.lyric-line').forEach((el, i) => {
    if (i === active) {
      el.style.color = `rgb(${lyricAccent})`; el.style.fontSize = '14px'; el.style.fontWeight = '600';
    } else {
      el.style.color = 'rgba(255,255,255,.4)'; el.style.fontSize = '13px'; el.style.fontWeight = '400';
    }
  });
  // Keep active line centered in lyric container
  if (active >= 0 && lyricContainer) {
    const line = document.getElementById('lr-' + active);
    if (line) {
      lyricContainer.scrollTo({ top: line.offsetTop - lyricContainer.clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' });
    }
  }
});

// ---- Session Persistence (localStorage, per-day) ----
function getSessionKey() {
  const d = new Date();
  return `claudio-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function saveSession() {
  try {
    const data = { playlist, messages, playlistIndex };
    localStorage.setItem(getSessionKey(), JSON.stringify(data));
  } catch {}
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(getSessionKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.playlist && Array.isArray(data.playlist)) {
      playlist = data.playlist;
      playlistIndex = typeof data.playlistIndex === 'number' ? data.playlistIndex : (playlist.length > 0 ? playlist.length - 1 : -1);
      renderQueue();
      updateQueueButtons();
      if (playlistIndex >= 0 && playlistIndex < playlist.length) {
        const current = playlist[playlistIndex];
        updateTrackInfo(current, false);
        void ensureTrackMeta(current).then((hydrated) => {
          if (hydrated && playlist[playlistIndex] === hydrated) updateTrackInfo(hydrated, false);
        });
      }
    }
    if (data.messages && Array.isArray(data.messages)) {
      messages = data.messages;
      for (const m of messages) {
        if (m.type === 'dj') addDJBubble(m.text, { instant: true, silent: true });
        else if (m.type === 'user') addUserBubble(m.text, true);
        else if (m.type === 'song') addSongCard(m.name, m.artist, m.url, m.id, true, { album: m.album, cover: m.cover });
        else if (m.type === 'segue') addSegueBubble(m.text, true);
      }
    }
  } catch {}
}

// Flip / History state
let isFlipped = false;
let historyRecords = [];
let historyTotal = 0;
const HISTORY_PAGE_SIZE = 200;

// ---- Utility ----
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function fmtTime(secs) {
  if (!secs || !isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function unlockMediaPlayback() {
  if (mediaUnlocked) return true;
  if (mediaUnlockPromise) return mediaUnlockPromise;

  mediaUnlockPromise = (async () => {
    const unlocker = new Audio(AUDIO_UNLOCK_SRC);
    unlocker.preload = 'auto';
    unlocker.muted = true;
    unlocker.playsInline = true;

    try {
      await unlocker.play();
      unlocker.pause();
      unlocker.currentTime = 0;
      mediaUnlocked = true;
      return true;
    } catch {
      return false;
    } finally {
      mediaUnlockPromise = null;
    }
  })();

  return mediaUnlockPromise;
}

// ---- Theme Toggle ----
const themeToggle = $('#theme-toggle');
themeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const theme = btn.dataset.theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Update meta theme-color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f0f0f4' : '#0a0a0f';
  localStorage.setItem('claudio-theme', theme);
});

// Restore theme
const savedTheme = localStorage.getItem('claudio-theme');
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeToggle.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === savedTheme);
  });
}

// ---- Settings Overlay ----
function openSettings() {
  overlayBackdrop.classList.add('open');
  settingsPanel.classList.add('open');
  loadTaste();
  fetchHealth();
}

function closeSettings() {
  overlayBackdrop.classList.remove('open');
  settingsPanel.classList.remove('open');
}

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-close').addEventListener('click', closeSettings);
overlayBackdrop.addEventListener('click', closeSettings);

// ---- Clock ----
function updateClock() {
  const now = new Date();
  const HH = String(now.getHours()).padStart(2, '0');
  const MM = String(now.getMinutes()).padStart(2, '0');
  if (clockEl) clockEl.textContent = `${HH}:${MM}`;

  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (weekdayEl) weekdayEl.textContent = days[now.getDay()];
  if (dateEl) dateEl.textContent =
    `${String(now.getDate()).padStart(2,'0')} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

updateClock();
setInterval(updateClock, 30000);

// ---- WebSocket ----
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/stream`);

  ws.onopen = () => {
    connBanner.classList.add('hidden');
    if (onAirDot) onAirDot.classList.remove('paused');
    if (chatDot) chatDot.classList.remove('paused');
    updateSettingsStatus(true);
    fetchHealth();
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWSEvent(msg.event, msg.data);
    } catch {}
  };

  ws.onclose = () => {
    updateSettingsStatus(false);
    if (onAirDot) onAirDot.classList.add('paused');
    if (chatDot) chatDot.classList.add('paused');
    connBanner.classList.remove('hidden');
    scheduleReconnect();
  };

  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 3000);
}

function handleWSEvent(event, data) {
  switch (event) {
    case 'connected':
      console.log('[WS] Connected v' + data?.version);
      break;

    case 'say':
      if (data?.text) addDJBubble(data.text);
      if (data?.autoStartMusic) {
        void prepareIncomingMusicAutostart();
      } else {
        pendingIncomingMusicAutostart = false;
      }
      if (data?.audio) playTTS(data.audio, data?.ttsId || null);
      break;

    case 'now-playing':
      if (data?.name) {
        const shouldActivateIncomingTrack = pendingIncomingMusicAutostart;
        pendingIncomingMusicAutostart = false;
        addSongCard(data.name, data.artist || '', data.url, data.id, false, {
          album: data.album || '',
          cover: data.cover || ''
        });
        addToPlaylist({
          name: data.name,
          artist: data.artist || 'Unknown',
          album: data.album || '',
          cover: data.cover || '',
          url: data.url || '',
          id: data.id || '',
          dbId: data.dbId || 0
        }, { activate: shouldActivateIncomingTrack });
      }
      break;

    case 'segue':
      if (data?.text) addSegueBubble(data.text);
      break;

    case 'plan-update':
      console.log('[WS] Plan update:', data);
      break;

    case 'error':
      toast(data?.text || 'Something went wrong', true);
      break;
  }
}

function setPlaylistHistory(tracks) {
  playlist = Array.isArray(tracks) ? tracks.slice() : [];
  playlistIndex = playlist.length > 0 ? playlist.length - 1 : -1;
  renderQueue();
  updateQueueButtons();

  if (playlistIndex >= 0) {
    const current = playlist[playlistIndex];
    updateTrackInfo(current, false);
    void ensureTrackMeta(current).then((hydrated) => {
      if (hydrated && playlist[playlistIndex] === hydrated) updateTrackInfo(hydrated, false);
    });
  } else {
    resetPlayer();
  }
}

// ---- Playlist Queue ----
function hasCurrentTrack() {
  return playlistIndex >= 0 && playlistIndex < playlist.length;
}

async function prepareIncomingMusicAutostart() {
  if (!audioMain.paused) {
    pendingIncomingMusicAutostart = false;
    return;
  }

  if (hasCurrentTrack()) {
    pendingIncomingMusicAutostart = false;
    if (audioMain.src) {
      try {
        await audioMain.play();
        return;
      } catch {}
    }
    await playCurrentTrack({ forceRefreshUrl: true });
    return;
  }

  pendingIncomingMusicAutostart = true;
}

function addToPlaylist(track, options = {}) {
  const { activate = false } = options;
  if (playlist.length > 0) {
    const last = playlist[playlist.length - 1];
    if (last.name === track.name && last.artist === track.artist) return;
  }

  if (activate) track.manual = true;
  playlist.push(track);
  renderQueue();

  if (activate) {
    playlistIndex = playlist.length - 1;
    void playCurrentTrack();
  } else if (playlistIndex < 0) {
    playlistIndex = 0;
    void playCurrentTrack();
  }

  updateQueueButtons();
  saveSession();
}

async function fetchTrackUrl(trackId) {
  if (!trackId) return '';
  try {
    const res = await fetch(`/api/song/${encodeURIComponent(trackId)}/url`);
    const data = await res.json();
    return data.ok && data.url ? data.url : '';
  } catch {
    return '';
  }
}

async function fetchTrackMeta(trackId) {
  if (!trackId) return { album: '', cover: '' };
  try {
    const res = await fetch(`/api/song/${encodeURIComponent(trackId)}/meta`);
    const data = await res.json();
    if (!data.ok) return { album: '', cover: '' };
    return {
      album: data.album || '',
      cover: data.cover || ''
    };
  } catch {
    return { album: '', cover: '' };
  }
}

async function ensureTrackMeta(track) {
  if (!track || !track.id) return track || null;
  if (track.album && track.cover) return track;
  const meta = await fetchTrackMeta(track.id);
  if (meta.album && !track.album) track.album = meta.album;
  if (meta.cover && !track.cover) track.cover = meta.cover;
  saveSession();
  return track;
}

async function ensureTrackUrl(track, forceRefresh = false) {
  if (!track) return '';
  if (!forceRefresh && track.url) return track.url;
  const freshUrl = await fetchTrackUrl(track.id);
  if (freshUrl) {
    track.url = freshUrl;
    saveSession();
  }
  return freshUrl;
}

async function playCurrentTrack(options = {}) {
  if (playlistIndex < 0 || playlistIndex >= playlist.length) return;
  const track = playlist[playlistIndex];
  await playAudio(track, options);
  renderQueue();
  updateQueueButtons();
  saveSession();

  if (playlistIndex === playlist.length - 1) triggerRefill();
}

async function playNext() {
  if (playlistIndex < playlist.length - 1) {
    playlistIndex++;
    await playCurrentTrack();
  }
  saveSession();
}

async function playPrev() {
  // If elapsed > 3s, restart current track
  if (audioMain.currentTime > 3) {
    audioMain.currentTime = 0;
    try {
      await audioMain.play();
    } catch {
      await playCurrentTrack({ forceRefreshUrl: true });
    }
    return;
  }
  if (playlistIndex > 0) {
    playlistIndex--;
    await playCurrentTrack();
  } else {
    audioMain.currentTime = 0;
    try {
      await audioMain.play();
    } catch {
      await playCurrentTrack({ forceRefreshUrl: true });
    }
  }
}

function removeFromPlaylist(index) {
  if (index < 0 || index >= playlist.length) return;
  const wasCurrent = index === playlistIndex;

  playlist.splice(index, 1);

  if (playlist.length === 0) {
    playlistIndex = -1;
    resetPlayer();
  } else if (wasCurrent) {
    if (playlistIndex >= playlist.length) playlistIndex = playlist.length - 1;
    playCurrentTrack();
  } else if (index < playlistIndex) {
    playlistIndex--;
  }

  renderQueue();
  updateQueueButtons();
  saveSession();
}

function updateQueueButtons() {
  btnPrev.disabled = playlist.length === 0;
  btnNext.disabled = playlistIndex >= playlist.length - 1;
}

function resetPlayer() {
  audioMain.pause();
  audioMain.src = '';
  audioMain.removeAttribute('src');
  updateTrackInfo(null, false);
  setPlayingState(false);
  updateProgress(0, 0);
  // Clear lyrics
  if (lyricContainer) { lyricContainer.remove(); lyricContainer = null; }
  lyricTimes = [];
}

function renderQueue() {
  if (!queueList || !queueCount) return;

  queueCount.textContent = `${playlist.length} TRACKS`;

  queueList.innerHTML = playlist.map((t, i) => {
    const cls = i === playlistIndex ? 'queue-item current' : 'queue-item';
    const idxHtml = i === playlistIndex
      ? '<span class="queue-idx">▶</span>'
      : `<span class="queue-idx">${i + 1}</span>`;
    return `
      <li class="${cls}" data-index="${i}">
        ${idxHtml}
        <span class="queue-name">${esc(t.name)}</span>
        <span class="queue-artist">${esc(t.artist)}</span>
        <button class="queue-minus" data-rm="${i}" aria-label="Remove from queue">−</button>
      </li>
    `;
  }).join('');

  // Click handlers
  queueList.querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.queue-minus')) return;
      const idx = parseInt(el.dataset.index);
      if (idx < 0 || idx >= playlist.length) return;
      if (idx === playlistIndex) {
        btnPlay.click();
      } else {
        playlistIndex = idx;
        playCurrentTrack();
      }
    });
  });

  queueList.querySelectorAll('.queue-minus').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.rm);
      removeFromPlaylist(idx);
    });
  });
}

// ---- Player Controls ----
function setPlayingState(playing) {
  isPlaying = playing;
  if (playing) {
    btnPlay.classList.add('playing');
    iconPlay.style.display = 'none';
    iconPause.style.display = '';
    trackStatus.textContent = 'PLAYING';
    trackStatus.classList.remove('muted');
    eqBars.classList.remove('paused');
  } else {
    btnPlay.classList.remove('playing');
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    trackStatus.textContent = 'PAUSED';
    trackStatus.classList.add('muted');
    eqBars.classList.add('paused');
  }
}

function updateTrackInfo(track) {
  const name = track?.name || 'Claudio';
  const artist = track?.artist || 'AI RADIO';
  const album = track?.album || 'Claudio Session';
  const cover = track?.cover || '';

  trackName.textContent = name;
  if (trackArtist) trackArtist.textContent = artist;
  if (trackAlbum) trackAlbum.textContent = album;

  if (trackCover) {
    if (cover) {
      trackCover.src = cover;
      trackCover.alt = `${name} cover`;
      trackCover.style.display = '';
      if (trackCoverFallback) trackCoverFallback.style.display = 'none';
    } else {
      trackCover.removeAttribute('src');
      trackCover.alt = '';
      trackCover.style.display = 'none';
      if (trackCoverFallback) trackCoverFallback.style.display = '';
    }
  }
}

if (trackCover) {
  trackCover.addEventListener('error', () => {
    trackCover.removeAttribute('src');
    trackCover.alt = '';
    trackCover.style.display = 'none';
    if (trackCoverFallback) trackCoverFallback.style.display = '';
  });
}

btnPlay.addEventListener('click', async () => {
  if (playlist.length === 0) return;
  if (audioMain.paused) {
    if (audioMain.src) {
      try {
        await audioMain.play();
      } catch {
        await playCurrentTrack({ forceRefreshUrl: true });
      }
    } else {
      await playCurrentTrack();
    }
  } else {
    audioMain.pause();
  }
});

btnPrev.addEventListener('click', () => { void playPrev(); });
btnNext.addEventListener('click', () => { void playNext(); });

btnStop.addEventListener('click', () => {
  audioMain.pause();
  audioMain.currentTime = 0;
  updateProgress(0, duration);
  setPlayingState(false);
});

// Volume
volSlider.addEventListener('input', () => {
  volume = volSlider.value / 100;
  audioMain.volume = volume;
  audioTts.volume = volume;
  localStorage.setItem('claudio-volume', volSlider.value);
});

// Restore volume
const savedVol = localStorage.getItem('claudio-volume');
if (savedVol) {
  volSlider.value = savedVol;
  volume = savedVol / 100;
  audioMain.volume = volume;
  audioTts.volume = volume;
}

// Volume hide/show toggle
btnHideVol.addEventListener('click', () => {
  showVolume = !showVolume;
  volWrap.style.display = showVolume ? 'flex' : 'none';
  btnHideVol.textContent = showVolume ? 'HIDE' : 'VOL';
});

// ---- Progress Bar ----
function updateProgress(current, dur) {
  duration = dur;
  timeElapsed.textContent = fmtTime(current);
  timeTotal.textContent = fmtTime(dur);
  const pct = dur > 0 ? (current / dur) * 100 : 0;
  progressFill.style.width = pct + '%';
}

progressTrack.addEventListener('click', (e) => {
  if (!duration || playlist.length === 0) return;
  const rect = progressTrack.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const seekTime = pct * duration;
  audioMain.currentTime = seekTime;
  updateProgress(seekTime, duration);
});

// ---- Audio Events ----
audioMain.addEventListener('timeupdate', () => {
  if (audioMain.duration && isFinite(audioMain.duration)) {
    updateProgress(audioMain.currentTime, audioMain.duration);
  }
});

let isRefilling = false;

function triggerRefill() {
  if (isRefilling) return;
  isRefilling = true;
  fetch('/api/refill', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) console.warn('[refill]', d.error);
    })
    .catch(() => {})
    .finally(() => { isRefilling = false; });
}

audioMain.addEventListener('ended', () => {
  if (playlistIndex < playlist.length - 1) {
    playlistIndex++;
    playCurrentTrack();
  } else if (isRefilling) {
    const check = () => {
      if (playlistIndex < playlist.length - 1) {
        playlistIndex++;
        playCurrentTrack();
      } else if (isRefilling) {
        setTimeout(check, 400);
      } else {
        setPlayingState(false);
        updateProgress(0, duration);
      }
    };
    setTimeout(check, 200);
  } else {
    setPlayingState(false);
    updateProgress(0, duration);
  }
});

audioMain.addEventListener('play', () => setPlayingState(true));
audioMain.addEventListener('pause', () => setPlayingState(false));

audioMain.addEventListener('loadedmetadata', () => {
  updateProgress(audioMain.currentTime, audioMain.duration);
});

audioMain.addEventListener('error', () => {
  if (isRecoveringPlayback) return;
  if (playlistIndex >= 0 && playlistIndex < playlist.length) {
    isRecoveringPlayback = true;
    toast('当前歌曲播放失败，正在尝试刷新链接', true);
    void playCurrentTrack({ forceRefreshUrl: true }).finally(() => {
      setTimeout(() => { isRecoveringPlayback = false; }, 400);
    });
  } else {
    toast('播放器发生错误', true);
  }
});

// ---- Audio Playback ----
async function playAudio(track, options = {}) {
  const { forceRefreshUrl = false } = options;
  if (!track) return false;

  await ensureTrackMeta(track);
  let url = await ensureTrackUrl(track, forceRefreshUrl);
  if (!url) {
    toast('当前歌曲暂无可用音频链接', true);
    return false;
  }

  if (audioMain.src !== url) audioMain.src = url;
  updateTrackInfo(track, true);
  updateProgress(0, 0);
  fetchLyricsForTrack(track);
  if (track.cover && window.setAlbumBg) window.setAlbumBg(track.cover);
  if (track.cover) extractLyricColor(track.cover, track.name);
  // DJ intro — only when NOT auto-refilling
  if (!isRefilling && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: 'manual-play', data: { name: track.name, artist: track.artist } }));
    console.log('[dj-intro] sent for', track.name);
  }

  try {
    await audioMain.play();
  } catch (err) {
    if (!forceRefreshUrl && track.id) {
      url = await ensureTrackUrl(track, true);
      if (url) {
        audioMain.src = url;
        try {
          await audioMain.play();
        } catch (retryErr) {
          console.warn('[player] retry play failed:', retryErr);
          toast('播放失败，请重试或换一首歌', true);
          return false;
        }
      } else {
        console.warn('[player] failed to refresh url:', err);
        toast('当前歌曲链接已失效，请换一首歌', true);
        return false;
      }
    } else {
      console.warn('[player] play failed:', err);
      toast('播放失败，请重试或换一首歌', true);
      return false;
    }
  }

  // Prefetch for SW cache
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'PREFETCH', url });
  }
  isRecoveringPlayback = false;
  return true;
}

function playTTS(url, ttsId = null) {
  if (!url) return;
  if (currentTts?.id && currentTts.id !== ttsId) finalizeTtsPlayback('interrupted');
  currentTts = { id: ttsId, url };
  audioTts.src = url;
  audioTts.volume = volume;
  audioTts.play().catch(() => {});
}

function notifySwDelete(url) {
  if (!url || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: 'DELETE_CACHE', url });
}

function reportTtsCompletion(active, status, preferBeacon = false) {
  if (!active?.id) return;
  const endpoint = `/api/tts/${encodeURIComponent(active.id)}/complete`;

  if (!preferBeacon) {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
      keepalive: true
    }).catch(() => {
      if (navigator.sendBeacon) {
        try { navigator.sendBeacon(`${endpoint}?status=${encodeURIComponent(status)}`); } catch {}
      }
    });
    return;
  }

  if (navigator.sendBeacon) {
    try {
      navigator.sendBeacon(`${endpoint}?status=${encodeURIComponent(status)}`);
      return;
    } catch {}
  }

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
    keepalive: true
  }).catch(() => {});
}

function finalizeTtsPlayback(status, options = {}) {
  const { preferBeacon = false } = options;
  const active = currentTts;
  if (!active) return;
  currentTts = null;

  if (active.url) notifySwDelete(active.url);
  reportTtsCompletion(active, status, preferBeacon);
}

audioTts.addEventListener('ended', () => {
  finalizeTtsPlayback('ended');
});

audioTts.addEventListener('error', () => {
  finalizeTtsPlayback('error');
});

window.addEventListener('pagehide', () => {
  finalizeTtsPlayback('pagehide', { preferBeacon: true });
});

// ---- Chat Messages ----
function hideWelcome() {
  if (!welcomeHidden && chatWelcome) {
    chatWelcome.classList.add('hidden');
    welcomeHidden = true;
  }
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function addDJBubble(text, options = {}) {
  const { instant = false, silent = false } = options;
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = `
    <div class="msg-avatar msg-avatar--dj">DJ</div>
    <div class="msg-body">
      <div class="msg-sender">CLAUDIO</div>
      <div class="msg-text"></div>
    </div>
  `;
  chatMessages.appendChild(row);

  const textEl = row.querySelector('.msg-text');
  if (instant) {
    textEl.textContent = text;
  } else {
    typewriterEffect(textEl, text, 0);
  }
  scrollChatToBottom();

  if (!silent) {
    messages.push({ type: 'dj', text });
    saveSession();
  }
}

function addUserBubble(text, silent = false) {
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = `
    <div class="msg-avatar msg-avatar--user">YOU</div>
    <div class="msg-body">
      <div class="msg-sender">YOU</div>
      <div class="msg-text">${esc(text)}</div>
    </div>
  `;
  chatMessages.appendChild(row);
  scrollChatToBottom();

  if (!silent) {
    messages.push({ type: 'user', text });
    saveSession();
  }
}

function typewriterEffect(el, text, cursorDelay) {
  let i = 0;
  const cursor = document.createElement('span');
  cursor.className = 'typewriter-cursor';

  function type() {
    if (i < text.length) {
      el.textContent += text.charAt(i);
      i++;
      const delay = 20 + Math.random() * 40;
      setTimeout(type, delay);
    } else {
      if (cursorDelay > 0) {
        el.appendChild(cursor);
        setTimeout(() => {
          if (cursor.parentNode) cursor.remove();
        }, cursorDelay);
      }
    }
  }

  type();
}

function addSongCard(name, artist, url, id, silent = false, extras = {}) {
  const { album = '', cover = '' } = extras;
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = `
    <div class="msg-avatar msg-avatar--dj">DJ</div>
    <div class="msg-body">
      <div class="msg-sender">CLAUDIO</div>
      <div class="msg-text">
        <span style="color:var(--accent)">♪</span> ${esc(name)} — ${esc(artist || 'Unknown')}
      </div>
    </div>
  `;
  row.style.cursor = 'pointer';
  row.addEventListener('click', () => {
    if (url) {
      addToPlaylist({ name, artist: artist || 'Unknown', album, cover, url, id: id || '' }, { activate: true });
    }
  });
  chatMessages.appendChild(row);
  scrollChatToBottom();

  if (!silent) {
    messages.push({ type: 'song', name, artist: artist || 'Unknown', album, cover, url: url || '', id: id || '' });
    saveSession();
  }
}

function addSegueBubble(text, silent = false) {
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = `
    <div class="msg-avatar msg-avatar--dj" style="opacity:.5">DJ</div>
    <div class="msg-body">
      <div class="msg-sender">CLAUDIO</div>
      <div class="msg-text" style="font-style:italic;color:var(--text-muted)">${esc(text)}</div>
    </div>
  `;
  chatMessages.appendChild(row);
  scrollChatToBottom();

  setTimeout(() => {
    if (row.parentNode) {
      row.style.opacity = '0';
      row.style.transition = 'opacity .5s';
      setTimeout(() => { if (row.parentNode) row.remove(); }, 500);
    }
  }, 3000);

  if (!silent) {
    messages.push({ type: 'segue', text });
    saveSession();
  }
}

// ---- Typing Indicator ----
function showTyping(show) {
  const existing = chatMessages.querySelector('.typing-indicator');
  if (show && !existing) {
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    chatMessages.appendChild(el);
    scrollChatToBottom();
  } else if (!show && existing) {
    existing.remove();
  }
}

// ---- Send Message ----
async function sendMessage(text) {
  if (isSending || !text.trim()) return;
  isSending = true;
  btnSend.disabled = true;
  chatInput.disabled = true;
  showTyping(true);

  const msg = text.trim();
  addUserBubble(msg);
  chatInput.value = '';

  await unlockMediaPlayback();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });

    const data = await res.json();
    if (!data.ok) {
      addDJBubble(data.error || 'Sorry, something went wrong.');
    }
  } catch (err) {
    toast('Network error', true);
    addDJBubble('Signal is weak, please try again.');
  } finally {
    showTyping(false);
    isSending = false;
    btnSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

// ---- Chat Input Events ----
btnSend.addEventListener('click', () => sendMessage(chatInput.value));
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

// ---- Today's Playlist Button ----
if (btnPlanToday) {
  btnPlanToday.addEventListener('click', async () => {
    if (btnPlanToday.disabled) return;
    btnPlanToday.disabled = true;
    btnPlanToday.classList.add('loading');
    btnPlanToday.textContent = '⏳ 生成中...';

    await unlockMediaPlayback();

    try {
      const res = await fetch('/api/plan/today', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        toast(data.error || 'Failed to generate playlist', true);
      }
    } catch (e) {
      toast('Network error', true);
    } finally {
      btnPlanToday.disabled = false;
      btnPlanToday.classList.remove('loading');
      btnPlanToday.textContent = '📋 今日歌单';
    }
  });
}

// Suggestion chips
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chat-chip')) {
    sendMessage(e.target.textContent);
  }
});

// ---- Settings Data ----
function updateSettingsStatus(online) {
  if (!settingsStatus) return;
  if (online) {
    settingsStatus.textContent = 'ONLINE';
    settingsStatus.className = 'status-badge status-online';
  } else {
    settingsStatus.textContent = 'OFFLINE';
    settingsStatus.className = 'status-badge status-offline';
  }
}

async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (settingsUptime) settingsUptime.textContent = formatUptime(data.uptime || 0);
    updateSettingsStatus(true);
  } catch {
    updateSettingsStatus(false);
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function loadTaste() {
  if (!tasteFiles) return;
  if (tasteLoading) tasteLoading.style.display = 'block';

  try {
    const res = await fetch('/api/taste');
    const data = await res.json();

    if (tasteLoading) tasteLoading.style.display = 'none';

    if (!data.files || data.files.length === 0) {
      tasteFiles.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No taste files found in user/ directory</p>';
      return;
    }

    tasteFiles.innerHTML = data.files.map(file => `
      <div class="taste-card">
        <div class="taste-card-head">${esc(file.name)}</div>
        <div class="taste-card-body">${esc(file.content)}</div>
      </div>
    `).join('');
  } catch {
    if (tasteLoading) tasteLoading.style.display = 'none';
    tasteFiles.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Failed to load taste files</p>';
  }
}

// ---- Toast ----
function toast(text, isError = false) {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast--error' : '');
  el.textContent = text;
  container.appendChild(el);

  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
}

// ---- PWA Install ----
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (btnInstall) btnInstall.classList.remove('hidden');
});

if (btnInstall) {
  btnInstall.addEventListener('click', () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then(() => {
      btnInstall.classList.add('hidden');
      installPrompt = null;
    });
  });
}

// ---- QUEUE Collapse Toggle ----
if (queueHeader) {
  queueHeader.addEventListener('click', () => {
    queueCollapsed = !queueCollapsed;
    if (queueCollapsed) {
      queueSection.classList.add('collapsed');
    } else {
      queueSection.classList.remove('collapsed');
    }
  });
}

// ---- Chat Collapse Toggle ----
if (chatHeader) {
  chatHeader.addEventListener('click', () => {
    chatCollapsed = !chatCollapsed;
    if (chatCollapsed) {
      chatSection.classList.add('collapsed');
    } else {
      chatSection.classList.remove('collapsed');
    }
  });
}

// ---- QUEUE Clear All ----
if (btnQueueClear) {
  btnQueueClear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playlist.length === 0) return;
    playlist = [];
    playlistIndex = -1;
    resetPlayer();
    renderQueue();
    updateQueueButtons();
    saveSession();
  });
}

// ---- Keyboard Shortcuts ----
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    btnPlay.click();
  }
});

// ---- Flip Card & History ----
btnRecord.addEventListener('click', () => {
  isFlipped = !isFlipped;
  if (isFlipped) {
    flipContainer.classList.add('flipped');
    btnRecord.classList.add('active');
    loadHistoryRecords();
    setTimeout(() => { if (flipFront) flipFront.style.visibility = 'hidden'; }, 600);
  } else {
    btnRecord.classList.remove('active');
    if (flipInner) flipInner.style.transform = 'rotateY(0deg)';
    setTimeout(() => { if (flipFront) flipFront.style.visibility = 'visible'; }, 300);
    setTimeout(() => {
      flipContainer.classList.remove('flipped');
      if (flipInner) flipInner.style.transform = '';
    }, 600);
  }
});

async function loadHistoryRecords() {
  if (!historyList) return;
  historyList.innerHTML = '<li class="history-empty">Loading...</li>';

  try {
    const res = await fetch(`/api/plays?limit=${HISTORY_PAGE_SIZE}&offset=0`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.plays)) {
      historyList.innerHTML = '<li class="history-empty">No records</li>';
      return;
    }
    historyRecords = data.plays.map(p => ({
      dbId: p.id,
      name: p.song_name,
      artist: p.artist || ''
    }));
    historyTotal = data.total || 0;
    renderHistory();
  } catch {
    historyList.innerHTML = '<li class="history-empty">Failed to load</li>';
  }
}

function renderHistory() {
  if (!historyList) return;

  if (historyRecords.length === 0) {
    historyList.innerHTML = '<li class="history-empty">No records</li>';
    return;
  }

  historyList.innerHTML = historyRecords.map((r, i) => `
    <li class="history-item" data-dbid="${r.dbId}">
      <span class="history-idx">${i + 1}</span>
      <span class="history-name">${esc(r.name)}</span>
      <span class="history-artist">${esc(r.artist)}</span>
      <button class="history-remove" data-rm="${r.dbId}" aria-label="Remove">&times;</button>
    </li>
  `).join('');

  historyList.querySelectorAll('.history-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dbId = parseInt(btn.dataset.rm);
      removeOneHistory(dbId);
    });
  });
}

async function removeOneHistory(dbId) {
  if (!historyList) return;

  try {
    await fetch(`/api/play/${dbId}`, { method: 'DELETE' });
  } catch {}

  historyRecords = historyRecords.filter(r => r.dbId !== dbId);
  historyTotal = Math.max(0, historyTotal - 1);

  if (historyRecords.length < HISTORY_PAGE_SIZE && historyTotal > historyRecords.length) {
    try {
      const res = await fetch(`/api/plays?limit=1&offset=${historyRecords.length}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.plays) && data.plays.length > 0) {
        const p = data.plays[0];
        historyRecords.push({
          dbId: p.id,
          name: p.song_name,
          artist: p.artist || ''
        });
      } else {
        historyTotal = historyRecords.length;
      }
    } catch {}
  }

  renderHistory();
}

btnClearAll.addEventListener('click', async () => {
  if (!historyList) return;
  if (historyRecords.length === 0) return;

  const ids = historyRecords.map(r => r.dbId);
  historyRecords = [];
  historyTotal = Math.max(0, historyTotal - ids.length);

  for (const dbId of ids) {
    try {
      await fetch(`/api/play/${dbId}`, { method: 'DELETE' });
    } catch {}
  }

  if (historyTotal > 0) {
    try {
      const res = await fetch(`/api/plays?limit=${HISTORY_PAGE_SIZE}&offset=0`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.plays)) {
        historyRecords = data.plays.map(p => ({
          dbId: p.id,
          name: p.song_name,
          artist: p.artist || ''
        }));
        historyTotal = data.total || 0;
      }
    } catch {}
  }

  renderHistory();
});

// ---- Init ----
async function initApp() {
  updateClock();
  restoreSession();
  connectWS();
  fetchHealth();
}

document.addEventListener('pointerdown', () => {
  void unlockMediaPlayback();
}, { passive: true });

document.addEventListener('keydown', () => {
  void unlockMediaPlayback();
});

initApp();

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pwa/sw.js').catch(() => {});
}

console.log('📻 Claudio FM ready');
