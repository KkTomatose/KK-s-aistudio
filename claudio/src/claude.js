// src/claude.js — Call LLM API (OpenAI-compatible)
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const LLM_JSON_MODE = process.env.LLM_JSON_MODE !== 'false';
const TIMEOUT_MS = 60000;

const FALLBACK = {
  say: '稍等，我找首歌放着。',
  play: [],
  reason: 'error',
  segue: ''
};

async function callLLM(userText, systemPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body = {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ]
  };
  if (LLM_JSON_MODE) {
    body.response_format = { type: 'json_object' };
  }

  try {
    const res = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[claude] LLM API error ${res.status}: ${text}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn('[claude] LLM returned empty response');
      return null;
    }
    return content.trim();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('[claude] LLM API timeout');
    } else {
      console.warn('[claude] Fetch error:', e.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function askClaudio(userText, systemPrompt) {
  if (!LLM_API_KEY) {
    console.warn('[claude] LLM_API_KEY not set, using fallback');
    return { ...FALLBACK, reason: 'no_api_key' };
  }

  try {
    const raw = await callLLM(userText, systemPrompt);
    if (!raw) return FALLBACK;

    let jsonStr = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];

    const parsed = JSON.parse(jsonStr);
    return {
      say: parsed.say || FALLBACK.say,
      play: parsed.play || [],
      reason: parsed.reason || '',
      segue: parsed.segue || ''
    };
  } catch (e) {
    console.warn('[claude] Parse error:', e.message);
    return FALLBACK;
  }
}

// TEST: node src/claude.js
// Asks LLM for working music (requires LLM_API_KEY in .env)
if (process.argv[1]?.endsWith('/src/claude.js') || process.argv[1]?.endsWith('\\src\\claude.js')) {
  import('dotenv/config').then(() => {
    console.log('[claude] Self-test: asking for afternoon work music...');
    askClaudio('推荐几首适合下午工作的歌', 'You are a helpful music DJ. Reply in JSON: {"say":"...","play":["Song - Artist"],"reason":"...","segue":"..."}')
      .then(result => console.log('[claude] Result:', JSON.stringify(result, null, 2)))
      .catch(e => console.error('[claude] Test failed:', e));
  });
}
