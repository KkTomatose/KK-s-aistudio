// src/calendar.js — Google Calendar integration
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const CRED_PATH = process.env.GOOGLE_CREDENTIALS_PATH || join(rootDir, 'credentials.json');
const TOKEN_PATH = join(rootDir, 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const OAUTH_PORT = 3000;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;

async function getCredentials() {
  const content = readFileSync(CRED_PATH, 'utf-8');
  const keys = JSON.parse(content);
  return { client_id: keys.installed.client_id, client_secret: keys.installed.client_secret, redirect_uris: keys.installed.redirect_uris };
}

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 * Returns the authorization code once Google redirects back.
 */
function receiveCodeViaLocalServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>授权失败</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>授权成功！</h1><p>你可以关闭此页面了。</p>');
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>缺少授权码</h1>');
    });

    server.listen(OAUTH_PORT, () => {
      console.log(`[calendar] 等待 OAuth 回调 http://localhost:${OAUTH_PORT} ...`);
    });

    server.on('error', (err) => {
      reject(new Error(`无法启动本地回调服务器 (端口 ${OAUTH_PORT} 可能被占用): ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth 授权超时 (120 秒)'));
    }, 120_000);
  });
}

async function getToken(oAuth2Client) {
  // If we already have a token, reuse it
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    console.log('[calendar] 已加载现有 token');
    return token;
  }

  const credentials = await getCredentials();

  // Build auth URL with explicit redirect_uri (port 3000, NOT port 80)
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    prompt: 'consent' // force refresh token on first auth
  });

  console.log('\n=== Google Calendar 授权 ===');
  console.log('请用浏览器打开以下 URL 完成授权:\n');
  console.log(authUrl);
  console.log('\n授权完成后浏览器会自动跳转到本地服务器，无需手动复制 code。\n');

  // Start local server to receive the callback
  const code = await receiveCodeViaLocalServer();

  console.log('[calendar] 收到授权码，正在换取 token...');
  const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: REDIRECT_URI });
  oAuth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('[calendar] Token 已保存到 token.json');
  return tokens;
}

let _authClient = null;

export async function authorizeCalendar() {
  const credentials = await getCredentials();
  const { client_secret, client_id } = credentials;
  // Pass explicit redirect URI (port 3000) so the client uses it for token refresh too
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
  await getToken(oAuth2Client);
  _authClient = oAuth2Client;
  return oAuth2Client;
}

export async function getTodayEvents() {
  try {
    const auth = _authClient || await authorizeCalendar();
    const calendar = google.calendar({ version: 'v3', auth });

    // Today in Asia/Shanghai
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = res.data.items || [];
    return events.map(e => {
      if (e.start.date && !e.start.dateTime) {
        return `全天 ${e.summary}`;
      }
      const time = new Date(e.start.dateTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `${time} ${e.summary}`;
    });
  } catch (e) {
    console.warn('[calendar] Failed:', e.message);
    return [];
  }
}
