// src/scheduler.js — Cron-based scheduler
import schedule from 'node-schedule';
import { getWeather } from './weather.js';
import { getTodayEvents } from './calendar.js';
import { buildContext } from './context.js';
import { askClaudio } from './claude.js';
import { synthesize } from './tts.js';
import { push as larkPush } from './lark.js';
import { savePref, getPref, getRecentPlays, savePlay } from './state.js';
import { matchFromPlaylists } from './analyzer.js';
import { search, getSongUrl, getSongInfo } from './ncm.js';

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

async function planDay(label = '早报', prompt = '今天是新的一天，请生成今日播单计划，推荐10首歌') {
  try {
    const now = new Date().toLocaleString('zh-CN');
    const weatherResult = await getWeather();
    const weather = `${weatherResult.text} ${weatherResult.temp}°C`;
    let events = [];
    try {
      events = JSON.parse(getPref('today_events') || '[]');
    } catch {}

    const ctx = buildContext({ userInput: prompt, env: { now, weather, events }, trace: `${label}触发` });
    const result = await askClaudio(ctx.user, ctx.system);

    if (label === '早报') {
      savePref('today_plan', JSON.stringify(result));
    }

    let tts = null;
    try {
      tts = await synthesize(result.say);
    } catch {}

    // Push to Feishu
    const msg = `📻 Claudio ${label}\n${result.say}\n今日歌单：${result.play.join('、')}`;
    await larkPush(msg);

    const songs = (result.play || []).slice(0, 10);

    // Broadcast via dynamic import to avoid circular dependency
    if (songs.length > 0) {
      try {
        const { broadcast } = await import('../server.js');
        broadcast('say', { text: result.say, audio: tts?.publicUrl || null, ttsId: tts?.id || null, autoStartMusic: true });
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
            const dbId = savePlay(song.name, song.artist, String(song.id), result.reason || label);
            broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
          }
        }
      } catch {}
    }
  } catch (e) {
    console.error('[scheduler] planDay error:', e);
  }
}

// Pre-fetch calendar at 08:55 daily
const j08_55 = schedule.scheduleJob('55 8 * * *', async () => {
  try {
    const events = await getTodayEvents();
    savePref('today_events', JSON.stringify(events));
    console.log('[scheduler] Calendar pre-fetched:', events.length, 'events');
  } catch (e) {
    console.error('[scheduler] Calendar pre-fetch error:', e);
  }
});

// 09:00 morning plan
const j09_00 = schedule.scheduleJob('0 9 * * *', () => planDay('早报', '今天是新的一天，请生成今日播单计划，推荐10首歌'));

// Every 40 min except 9 — mood check
const moodCheck = schedule.scheduleJob('0,40 * * * *', async () => {
  const hour = new Date().getHours();
  if (hour === 9) return;

  try {
    const recent = getRecentPlays(3);
    if (recent.length === 0) return;

    const recentStr = recent.map(p => `${p.song_name} - ${p.artist}`).join(', ');
    const ctx = buildContext({
      userInput: `根据最近播放（${recentStr}），现在适合换个风格吗？如果是，推荐一首`,
      env: { now: new Date().toLocaleString('zh-CN'), weather: '未知', events: [] },
      trace: '整点心情检测'
    });
    const result = await askClaudio(ctx.user, ctx.system);

    if (result.play && result.play.length > 0) {
      try {
        const { broadcast } = await import('../server.js');
        broadcast('say', { text: result.say });
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
            const dbId = savePlay(song.name, song.artist, String(song.id), result.reason || 'mood_check');
            broadcast('now-playing', await buildNowPlayingPayload(song, url, dbId));
          }
        }
      } catch {}
    }
  } catch (e) {
    console.error('[scheduler] moodCheck error:', e);
  }
});

export function startScheduler() {
  console.log('[scheduler] Scheduled: 08:55 calendar pre-fetch, 09:00 morning plan, 40-min mood check');
}
