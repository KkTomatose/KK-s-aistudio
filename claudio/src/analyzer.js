// src/analyzer.js — Playlist analysis engine
// Fetches playlist tracks, computes taste profile, auto-fills taste.md, caches to state.db prefs
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPlaylistAllTracks, getPlaylistInfo } from './ncm.js';
import { savePref, getPref } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function readPlaylistConfig() {
  try {
    const raw = readFileSync(join(rootDir, 'user', 'playlists.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { uid: '', playlists: [] };
  }
}

// ---------------------------------------------------------------------------
// Language detection helpers
// ---------------------------------------------------------------------------

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function hasEnglish(text) {
  return /[a-zA-Z]{2,}/.test(text);
}

// ---------------------------------------------------------------------------
// Style / tag aggregation
// ---------------------------------------------------------------------------

/**
 * Infer preferred styles from playlist tags and names.
 */
function inferStyles(playlistTags, playlistNames, langDist) {
  const styles = [];

  // Collect tags from all playlists
  const tagSet = new Set();
  for (const tags of playlistTags) {
    for (const t of tags) {
      if (t && typeof t === 'string') tagSet.add(t);
    }
  }
  if (tagSet.size > 0) {
    styles.push(...tagSet);
  }

  // Infer from language distribution
  if (langDist.zh > 0.5) styles.push('华语');
  if (langDist.en > 0.3) styles.push('欧美');

  // Infer from playlist names
  const allNames = playlistNames.join(' ').toLowerCase();
  const nameHints = [
    [/工作|专注|学习|coding/, '工作/学习背景音乐'],
    [/睡前|晚安|入眠|安静|睡眠/, '安静氛围音乐'],
    [/运动|跑步|健身|锻炼/, '运动/节奏音乐'],
    [/开车|驾驶|路上|旅途/, '驾驶音乐'],
    [/古典|钢琴|纯音乐|轻音乐|器乐/, '纯音乐/器乐'],
    [/jazz|爵士/, '爵士'],
    [/rock|摇滚/, '摇滚'],
    [/电子|electro|edm|电音/, '电子'],
    [/民谣|folk/, '民谣'],
    [/说唱|rap|hip.hop|嘻哈/, '嘻哈/说唱'],
    [/r&b|rnb|节奏蓝调/, 'R&B'],
    [/indie|独立/, '独立音乐'],
    [/jpop|日系|日本/, '日系音乐'],
    [/kpop|韩系|韩国|k-pop/, '韩系音乐'],
    [/古风|国风|中国风/, '国风'],
  ];
  for (const [re, label] of nameHints) {
    if (re.test(allNames) && !styles.includes(label)) {
      styles.push(label);
    }
  }

  return styles.length > 0 ? styles.join('、') : '';
}

/**
 * Map playlist names to time-of-day preferences.
 */
function inferTimePrefs(playlistNames) {
  const prefs = { morning: '', work: '', evening: '', night: '' };

  const rules = [
    [/早晨|早上|起床|清晨|morning/, 'morning'],
    [/工作|办公|上班|专注|学习|coding|work|study/, 'work'],
    [/傍晚|下班|黄昏|傍晚|日落|回家|evening/, 'evening'],
    [/睡前|晚安|入眠|深夜|睡觉|睡眠|night|sleep/, 'night'],
    [/运动|跑步|健身|锻炼|sport|gym|run/, 'work'],  // 运动归类到活跃时段
    [/开车|驾驶|路上|旅途|drive/, 'evening'],
  ];

  for (const name of playlistNames) {
    for (const [re, slot] of rules) {
      if (re.test(name) && !prefs[slot]) {
        // Extract the relevant part from the playlist name
        const desc = name.length > 12 ? name.substring(0, 12) + '…' : name;
        prefs[slot] = `听「${desc}」歌单`;
      }
    }
  }

  return prefs;
}

// ---------------------------------------------------------------------------
// taste.md auto-fill
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /[（(]请填写|^-\s*(早晨|工作中|傍晚|睡前)：\s*$/m;

/**
 * Check if a section value is still a placeholder / unfilled.
 */
function isPlaceholder(value) {
  if (!value || value.trim() === '') return true;
  return PLACEHOLDER_RE.test(value);
}

/**
 * Parse taste.md into sections, fill empty ones with analysis results, write back.
 */
function updateTasteFile(stats) {
  const tastePath = join(rootDir, 'user', 'taste.md');
  let content;
  try {
    content = readFileSync(tastePath, 'utf-8');
  } catch {
    console.warn('[analyzer] taste.md not found, skipping auto-fill');
    return;
  }

  const { topArtists, styles, timePrefs, langDist } = stats;

  // Build replacements for each section
  const replacements = {};

  // -- 喜欢的歌手 --
  if (topArtists.length > 0) {
    replacements['喜欢的歌手'] = topArtists
      .slice(0, 15)
      .map(([name, count]) => `${name}（${count}首）`)
      .join('、');
  }

  // -- 偏好风格 --
  if (styles) {
    replacements['偏好风格'] = styles;
  } else if (langDist.zh > 0.5) {
    replacements['偏好风格'] = '华语为主' + (langDist.en > 0.2 ? '，兼听欧美' : '');
  }

  // -- 时段偏好 --
  if (timePrefs.morning) {
    replacements['早晨'] = timePrefs.morning;
  }
  if (timePrefs.work) {
    replacements['工作中'] = timePrefs.work;
  }
  if (timePrefs.evening) {
    replacements['傍晚'] = timePrefs.evening;
  }
  if (timePrefs.night) {
    replacements['睡前'] = timePrefs.night;
  }

  // Apply replacements — only overwrite placeholder content
  let updated = content;

  // Replace section content: "## 偏好风格\n（请填写...）" → "## 偏好风格\n{styles}"
  // Match: section header + placeholder content
  for (const [section, value] of Object.entries(replacements)) {
    // Match the section header followed by placeholder content
    // Pattern: "## {section}\n<any placeholder content>"
    const headerPattern = new RegExp(
      `(##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|\\n#\\s|$)`,
      'i'
    );
    const match = updated.match(headerPattern);
    if (match) {
      const fullMatch = match[0];
      const header = match[1];
      const body = match[2];

      if (isPlaceholder(body)) {
        // Only replace if it's still a placeholder
        updated = updated.replace(fullMatch, header + value + '\n');
      }
    }
  }

  // Handle time-preference bullets: "- 早晨：" → "- 早晨：{value}"
  for (const [slot, value] of Object.entries(timePrefs)) {
    if (!value) continue;
    const labelMap = { morning: '早晨', work: '工作中', evening: '傍晚', night: '睡前' };
    const label = labelMap[slot];
    if (!label) continue;
    // Only replace if the value after colon is empty
    const bulletPattern = new RegExp(`(- ${label}：)\\s*$`, 'm');
    if (bulletPattern.test(updated)) {
      updated = updated.replace(bulletPattern, `$1${value}`);
    }
  }

  if (updated !== content) {
    writeFileSync(tastePath, updated, 'utf-8');
    console.log('[analyzer] taste.md updated with analysis results');
  } else {
    console.log('[analyzer] taste.md unchanged (user content preserved)');
  }
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

/**
 * Analyze all configured playlists, cache results, and auto-fill taste.md.
 */
export async function analyzePlaylists() {
  const config = readPlaylistConfig();
  const { playlists } = config;

  if (!playlists || playlists.length === 0) {
    const emptyProfile = '# 歌单分析\n暂无歌单数据。请在 user/playlists.json 中添加歌单 ID。';
    savePref('taste_profile', emptyProfile);
    savePref('playlist_songs', '[]');
    savePref('taste_top_artists', '[]');
    return { profile: emptyProfile, totalSongs: 0, topArtists: [] };
  }

  // Fetch all tracks + playlist info in parallel
  const playlistData = [];
  for (const pl of playlists) {
    try {
      const [tracks, info] = await Promise.all([
        getPlaylistAllTracks(pl.id),
        getPlaylistInfo(pl.id).catch(() => ({ name: pl.name, tags: [], description: '', trackCount: 0 }))
      ]);
      playlistData.push({ config: pl, tracks, info });
      console.log(`[analyzer] Playlist "${info.name || pl.name}" (${pl.id}): ${tracks.length} tracks, tags: [${info.tags?.join(', ') || ''}]`);
    } catch (e) {
      console.warn(`[analyzer] Failed to fetch playlist ${pl.id}:`, e.message);
    }
  }

  const allSongs = playlistData.flatMap(d => d.tracks);

  if (allSongs.length === 0) {
    const existingProfile = getPref('taste_profile');
    if (existingProfile) {
      const existingSongs = JSON.parse(getPref('playlist_songs') || '[]');
      const existingArtists = JSON.parse(getPref('taste_top_artists') || '[]');
      console.warn(`[analyzer] Failed to fetch any playlists. Keeping previous cache (${existingSongs.length} songs, ${existingArtists.length} artists).`);
      return { profile: existingProfile, totalSongs: existingSongs.length, topArtists: existingArtists };
    }
    const emptyProfile = '# 歌单分析\n未能获取歌单数据，请检查网易云 API 是否运行、Cookie 是否有效。';
    savePref('taste_profile', emptyProfile);
    savePref('playlist_songs', '[]');
    savePref('taste_top_artists', '[]');
    return { profile: emptyProfile, totalSongs: 0, topArtists: [] };
  }

  // Deduplicate by song id
  const seen = new Map();
  for (const s of allSongs) {
    if (!seen.has(s.id)) seen.set(s.id, s);
  }
  const uniqueSongs = [...seen.values()];

  // Count artist frequency
  const artistCount = new Map();
  for (const s of uniqueSongs) {
    const artists = s.artist.split('/');
    for (const a of artists) {
      const name = a.trim();
      if (name) artistCount.set(name, (artistCount.get(name) || 0) + 1);
    }
  }

  const topArtists = [...artistCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // Language distribution
  let zhCount = 0, enCount = 0, otherCount = 0;
  for (const s of uniqueSongs) {
    const name = s.name + s.artist;
    if (hasChinese(name)) zhCount++;
    else if (hasEnglish(name)) enCount++;
    else otherCount++;
  }
  const total = uniqueSongs.length || 1;
  const langDist = { zh: zhCount / total, en: enCount / total, other: otherCount / total };

  // Aggregate tags and names
  const playlistTags = playlistData.map(d => d.info.tags || []);
  const playlistNames = playlistData.map(d => d.info.name || d.config.name || '');

  // Infer styles and time preferences
  const styles = inferStyles(playlistTags, playlistNames, langDist);
  const timePrefs = inferTimePrefs(playlistNames);

  // Build text profile for AI context
  let profile = '# 歌单分析\n';
  profile += `\n共 ${playlists.length} 个歌单，${uniqueSongs.length} 首不重复歌曲。\n`;

  if (topArtists.length > 0) {
    profile += '\n## 高频歌手\n';
    profile += topArtists
      .slice(0, 20)
      .map(([name, count], i) => `${i + 1}. ${name}（${count}首）`)
      .join('\n');
  }

  if (styles) {
    profile += `\n\n## 推断风格\n${styles}\n`;
  }

  profile += '\n## 歌单歌曲抽样（供选曲参考）\n';
  const sampleSize = Math.min(50, uniqueSongs.length);
  const samples = uniqueSongs.slice(0, sampleSize);
  profile += samples
    .map(s => `- ${s.name} - ${s.artist}`)
    .join('\n');

  // Cache to prefs
  savePref('taste_profile', profile);
  savePref('playlist_songs', JSON.stringify(uniqueSongs.slice(0, 500)));
  savePref('taste_top_artists', JSON.stringify(topArtists.slice(0, 20)));

  console.log(`[analyzer] Analysis complete: ${uniqueSongs.length} songs, top artist: ${topArtists[0]?.[0] || 'N/A'}`);

  // Auto-fill taste.md with discovered preferences
  try {
    updateTasteFile({
      topArtists,
      styles,
      timePrefs,
      langDist
    });
  } catch (e) {
    console.warn('[analyzer] Failed to update taste.md:', e.message);
  }

  return {
    profile,
    totalSongs: uniqueSongs.length,
    topArtists: topArtists.slice(0, 20)
  };
}

// ---------------------------------------------------------------------------
// Cached accessors
// ---------------------------------------------------------------------------

export function getTasteProfile() {
  return getPref('taste_profile');
}

export function getPlaylistSongs() {
  try {
    return JSON.parse(getPref('playlist_songs') || '[]');
  } catch {
    return [];
  }
}

export function matchFromPlaylists(query) {
  const songs = getPlaylistSongs();
  if (songs.length === 0) return [];

  const q = query.toLowerCase();
  const scored = songs
    .map(s => {
      const nameMatch = s.name.toLowerCase().includes(q);
      const artistMatch = s.artist.toLowerCase().includes(q);
      if (!nameMatch && !artistMatch) return { ...s, score: 0 };
      const score = (nameMatch ? 10 : 0) + (artistMatch ? 5 : 0);
      return { ...s, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return scored;
}
