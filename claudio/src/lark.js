// src/lark.js — Feishu Webhook push
export async function push(text) {
  try {
    const webhook = process.env.LARK_WEBHOOK;
    if (!webhook) {
      console.warn('[lark] LARK_WEBHOOK not configured');
      return false;
    }

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text }
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.warn('[lark] Push failed:', e.message);
    return false;
  }
}
