// scripts/setup-gcal.js — Google Calendar OAuth setup
// Usage: node scripts/setup-gcal.js
import 'dotenv/config';
import { authorizeCalendar, getTodayEvents } from '../src/calendar.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const tokenPath = join(rootDir, 'token.json');

async function main() {
  console.log('=== Google Calendar 授权 ===\n');

  const already = existsSync(tokenPath);

  try {
    const auth = await authorizeCalendar();

    if (already) {
      console.log('已授权，测试拉取今日事件...\n');
      const events = await getTodayEvents();
      if (events.length > 0) {
        console.log('今日日程：');
        events.forEach(e => console.log('  -', e));
      } else {
        console.log('今日无日程');
      }
    } else {
      console.log('\n授权成功！token.json 已保存。');
      console.log('现在拉取今日事件...\n');
      const events = await getTodayEvents();
      if (events.length > 0) {
        events.forEach(e => console.log('  -', e));
      } else {
        console.log('今日无日程');
      }
    }
  } catch (e) {
    console.error('授权失败：', e.message);
    if (!existsSync(join(rootDir, 'credentials.json'))) {
      console.log('\n请确保 credentials.json（Google Cloud Console OAuth 2.0 桌面应用）已放在项目根目录');
    }
    process.exit(1);
  }
}

main();
