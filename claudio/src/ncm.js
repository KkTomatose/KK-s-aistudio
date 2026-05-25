// src/ncm.js — NeteaseCloudMusicApi wrapper
// Requires NeteaseCloudMusicApi running (e.g. Docker container on port 3000)

const BASE = () => process.env.NCM_BASE || 'http://localhost:3000';
const COOKIE = () => process.env.NCM_COOKIE || '';

async function api(path, fallback) {
  try {
    const url = `${BASE()}${path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`[ncm] ${path} failed:`, e.message);
    return fallback;
  }
}

// a. Search songs
export async function search(keyword, limit = 10) {
  const data = await api(
    `/search?keywords=${encodeURIComponent(keyword)}&limit=${limit}&cookie=${COOKIE()}`,
    {}
  );
  const songs = data?.result?.songs ?? [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artist: (s.artists || s.ar || []).map(a => a.name).join('/'),
    album: s.album?.name ?? s.al?.name ?? '',
    cover: s.album?.picUrl ?? s.al?.picUrl ?? '',
    duration: s.duration
  }));
}

// b. Get mp3 stream URL
export async function getSongUrl(id) {
  const data = await api(
    `/song/url/v1?id=${id}&level=standard&cookie=${COOKIE()}`,
    {}
  );
  const url = data?.data?.[0]?.url;
  return url || null;
}

// c. Get LRC lyrics
export async function getLyric(id) {
  const data = await api(
    `/lyric?id=${id}&cookie=${COOKIE()}`,
    {}
  );
  return data?.lrc?.lyric || '';
}

// d. Get daily recommended songs
export async function getRecommend(limit = 10) {
  const data = await api(
    `/recommend/songs?cookie=${COOKIE()}`,
    {}
  );
  const songs = data?.data?.dailySongs ?? [];
  return songs.slice(0, limit).map(s => ({
    id: s.id,
    name: s.name,
    artist: (s.ar || []).map(a => a.name).join('/'),
    album: s.al?.name ?? '',
    cover: s.al?.picUrl ?? '',
    duration: s.dt
  }));
}

// d2. Get song detail (album / cover)
export async function getSongInfo(id) {
  const data = await api(
    `/song/detail?ids=${id}&cookie=${COOKIE()}`,
    {}
  );
  const song = data?.songs?.[0];
  return {
    album: song?.al?.name ?? '',
    cover: song?.al?.picUrl ?? ''
  };
}

// e. Validate cookie
export async function loginByCookie(cookie) {
  try {
    const url = `${BASE()}/user/account?cookie=${cookie}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      valid: data?.account !== null && data?.code === 200,
      nickname: data?.profile?.nickname ?? ''
    };
  } catch (e) {
    console.warn('[ncm] loginByCookie failed:', e.message);
    return { valid: false, nickname: '' };
  }
}

// f. Get user's playlists
export async function getUserPlaylists(uid) {
  const data = await api(
    `/user/playlist?uid=${uid}&cookie=${COOKIE()}`,
    {}
  );
  const list = data?.playlist ?? [];
  return list.map(p => ({
    id: p.id,
    name: p.name,
    trackCount: p.trackCount,
    coverImgUrl: p.coverImgUrl
  }));
}

// g. Get playlist detail (includes first batch of tracks)
export async function getPlaylistDetail(id) {
  const data = await api(
    `/playlist/detail?id=${id}&cookie=${COOKIE()}`,
    {}
  );
  const tracks = data?.playlist?.tracks ?? [];
  return tracks.map(s => ({
    id: s.id,
    name: s.name,
    artist: (s.ar || []).map(a => a.name).join('/'),
    album: s.al?.name ?? '',
    cover: s.al?.picUrl ?? '',
    duration: s.dt
  }));
}

// h. Get all tracks from a playlist (handles pagination)
export async function getPlaylistAllTracks(id) {
  const allSongs = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const data = await api(
      `/playlist/track/all?id=${id}&limit=${limit}&offset=${offset}&cookie=${COOKIE()}`,
      {}
    );
    const songs = data?.songs ?? [];
    if (songs.length === 0) break;

    allSongs.push(...songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: (s.ar || []).map(a => a.name).join('/'),
      album: s.al?.name ?? '',
      cover: s.al?.picUrl ?? '',
      duration: s.dt
    })));

    if (songs.length < limit) break;
    offset += limit;
  }

  return allSongs;
}

// i. Get playlist info (name, tags, description)
export async function getPlaylistInfo(id) {
  const data = await api(
    `/playlist/detail?id=${id}&cookie=${COOKIE()}`,
    {}
  );
  const pl = data?.playlist ?? {};
  return {
    name: pl.name ?? '',
    tags: pl.tags ?? [],
    description: pl.description ?? '',
    trackCount: pl.trackCount ?? 0
  };
}

// TEST: node src/ncm.js
// Searches "晴天 周杰伦", prints first result
if (process.argv[1]?.endsWith('/src/ncm.js') || process.argv[1]?.endsWith('\\src\\ncm.js')) {
  console.log('[ncm] Self-test: searching 晴天 周杰伦...');
  search('晴天 周杰伦', 3).then(async results => {
    if (results.length === 0) {
      console.log('[ncm] No results — is NeteaseCloudMusicApi running on', BASE(), '?');
      return;
    }
    const first = results[0];
    console.log('[ncm] Found:', first.id, first.name, first.artist);
    const url = await getSongUrl(first.id);
    console.log('[ncm] URL:', url ? url.substring(0, 80) + '...' : '(null — may need valid cookie)');
  });
}
