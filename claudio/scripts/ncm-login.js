// scripts/ncm-login.js — NetEase Cloud Music QR login
// Usage: node scripts/ncm-login.js
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');
const BASE = process.env.NCM_BASE || 'http://localhost:3000';

async function main() {
  console.log('=== 网易云音乐 二维码登录 ===\n');

  // 1. Get QR key
  const keyRes = await fetch(`${BASE}/login/qr/key`);
  const keyData = await keyRes.json();
  if (!keyData.data?.unikey) {
    console.error('Failed to get QR key. Is NeteaseCloudMusicApi running on', BASE, '?');
    process.exit(1);
  }
  const unikey = keyData.data.unikey;

  // 2. Get QR image (base64)
  const qrRes = await fetch(`${BASE}/login/qr/create?key=${unikey}&qrimg=true`);
  const qrData = await qrRes.json();
  if (!qrData.data?.qrimg) {
    console.error('Failed to get QR code.');
    process.exit(1);
  }

  // 3. Write QR image (strip data URL prefix)
  const b64 = qrData.data.qrimg.replace(/^data:image\/\w+;base64,/, '');
  const imgBuf = Buffer.from(b64, 'base64');
  writeFileSync(join(rootDir, 'qr.png'), imgBuf);
  console.log('请用网易云 App 扫描二维码（qr.png）\n');

  // 4. Poll for login status
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const checkRes = await fetch(`${BASE}/login/qr/check?key=${unikey}`);
    const checkData = await checkRes.json();

    if (checkData.code === 803) {
      // Success
      const cookie = checkData.cookie;
      console.log('\n登录成功！');

      // Read .env, replace NCM_COOKIE=
      let envContent = readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/^NCM_COOKIE=.*$/m, `NCM_COOKIE=${cookie}`);
      writeFileSync(envPath, envContent, 'utf-8');
      console.log('Cookie 已写入 .env');
      process.exit(0);
    } else if (checkData.code === 800) {
      console.log('二维码已过期，请重新运行');
      process.exit(1);
    } else if (checkData.code === 802) {
      process.stdout.write('\r请在手机上确认登录...');
    } else {
      process.stdout.write('.');
    }
  }

  console.log('\n超时，请重新运行');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(e => { console.error(e); process.exit(1); });
