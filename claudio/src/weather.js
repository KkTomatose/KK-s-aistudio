// src/weather.js — QWeather real-time weather
const FETCH_TIMEOUT_MS = 10000;

export async function getWeather() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const key = process.env.QWEATHER_KEY;
    const loc = process.env.QWEATHER_LOCATION || '101010100';
    const host = process.env.QWEATHER_HOST || 'devapi.qweather.com';
    const url = `https://${host}/v7/weather/now?location=${loc}&key=${key}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const now = data.now || {};
    return {
      text: now.text || '未知',
      temp: now.temp || '--',
      windDir: now.windDir || '',
      humidity: now.humidity || '',
      updateTime: now.obsTime || ''
    };
  } catch (e) {
    console.warn('[weather] Fetch failed:', e.message);
    return { text: '未知', temp: '--', windDir: '', humidity: '', updateTime: '' };
  } finally {
    clearTimeout(timer);
  }
}
