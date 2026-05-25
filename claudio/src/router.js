// src/router.js — Intent routing
const ROUTES = [
  [/^(播放|放一首|play|来首)/i, 'music'],
  [/^(天气|现在几点|日历|今天有什么)/i, 'direct'],
];

export function route(input) {
  for (const [re, intent] of ROUTES) {
    if (re.test(input)) return intent;
  }
  return 'claude';
}
