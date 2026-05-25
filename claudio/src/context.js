// src/context.js — Build system/user prompts for Claude
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getRecentPlays } from './state.js';
import { getTasteProfile } from './analyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function readFileSafe(path) {
  try { return readFileSync(path, 'utf-8'); }
  catch { return ''; }
}

export function buildContext({ userInput, env, trace }) {
  // ① DJ persona
  const persona = readFileSafe(join(rootDir, 'prompts', 'dj-persona.md'));

  // ② User profile files
  const userDir = join(rootDir, 'user');
  let userProfile = '';
  try {
    const files = readdirSync(userDir).filter(f => f.endsWith('.md'));
    userProfile = '# 用户资料\n' + files
      .map(f => readFileSafe(join(userDir, f)))
      .filter(Boolean)
      .join('\n\n');
  } catch {}

  // ③ Playlist analysis (cached taste profile)
  let tasteProfile = getTasteProfile();
  if (!tasteProfile) tasteProfile = '';

  // ④ Environment
  let envStr = '# 当前环境\n';
  envStr += `时间：${env.now || new Date().toLocaleString('zh-CN')}\n`;
  envStr += `天气：${env.weather || '未知'}\n`;
  if (env.events && env.events.length > 0) {
    envStr += '今日日程：\n' + env.events.map(e => `- ${e}`).join('\n');
  } else {
    envStr += '今日日程：无\n';
  }

  // ④ Recent plays
  let playsStr = '# 最近播放（不要重复）\n';
  const plays = getRecentPlays(10);
  if (plays.length > 0) {
    playsStr += plays
      .map(p => `- ${p.song_name} - ${p.artist}（${new Date(p.ts * 1000).toLocaleTimeString('zh-CN')}）`)
      .join('\n');
  } else {
    playsStr += '（暂无播放记录）\n';
  }

  const system = [persona, userProfile, tasteProfile, envStr, playsStr].filter(Boolean).join('\n\n---\n\n');
  const user = [userInput, trace].filter(Boolean).join('\n');

  return { system, user };
}
