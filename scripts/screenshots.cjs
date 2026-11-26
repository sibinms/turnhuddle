#!/usr/bin/env node
// Website and release-note screenshots, rendered from the extension's real chat panel HTML
// (dist/conversationView.js) inside a VS Code-style window, in light and dark.
// The conversations are sample data written for the screenshots; the panel markup and styles are the shipped ones.
//
//   npm run compile && node scripts/screenshots.cjs [outDir]      (default: site/screenshots)
//
// Needs Google Chrome (headless). Set CHROME to use another Chromium-based browser.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const view = require('../dist/conversationView');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'site', 'screenshots'));
const WORK = path.join(ROOT, '.screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 960, SIDEBAR = 520, THREADS = 250, SCALE = 1.25;
const NOW = Date.now();
const at = s => new Date(NOW + s * 1000);
const ID = '7c1e0a52-4b8d-4f0e-9a51-3d2f6b1c9e04';

const THEMES = {
  dark: {
    vars: { foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'sideBar-background': '#181818', 'editor-background': '#1f1f1f', 'editorWidget-background': '#202020', 'widget-border': '#2b2b2b', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898', focusBorder: '#0078d4', 'textLink-foreground': '#4daafc', 'textCodeBlock-background': '#2b2b2b', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8', 'progressBar-background': '#0078d4', 'testing-iconPassed': '#73c991', 'testing-iconFailed': '#f14c4c', 'editorWarning-foreground': '#cca700', errorForeground: '#f85149' },
    chrome: { title: '#181818', activity: '#181818', activityFg: '#868686', activityActive: '#d7d7d7', border: '#2b2b2b', editor: '#1f1f1f', tabActive: '#1f1f1f', tabInactive: '#181818', status: '#181818', statusFg: '#cccccc', gutter: '#6e7681', text: '#cccccc', kw: '#569cd6', str: '#ce9178', fn: '#dcdcaa', ty: '#4ec9b0', cm: '#6a9955', num: '#b5cea8', vr: '#9cdcfe', quick: '#252526', quickSel: '#04395e', shadow: 'rgba(0,0,0,.55)' }
  },
  light: {
    vars: { foreground: '#3b3b3b', descriptionForeground: '#717171', 'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', 'editorWidget-background': '#f8f8f8', 'widget-border': '#e5e5e5', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'input-placeholderForeground': '#767676', focusBorder: '#005fb8', 'textLink-foreground': '#005fb8', 'textCodeBlock-background': '#f0f0f0', 'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b', 'progressBar-background': '#005fb8', 'testing-iconPassed': '#388a34', 'testing-iconFailed': '#e51400', 'editorWarning-foreground': '#bf8803', errorForeground: '#e51400' },
    chrome: { title: '#f8f8f8', activity: '#f8f8f8', activityFg: '#8a8a8a', activityActive: '#1f1f1f', border: '#e5e5e5', editor: '#ffffff', tabActive: '#ffffff', tabInactive: '#f8f8f8', status: '#f8f8f8', statusFg: '#3b3b3b', gutter: '#8a8a8a', text: '#3b3b3b', kw: '#0000ff', str: '#a31515', fn: '#795e26', ty: '#267f99', cm: '#008000', num: '#098658', vr: '#001080', quick: '#f8f8f8', quickSel: '#e8e8e8', shadow: 'rgba(0,0,0,.18)' }
  }
};

// ---------- sample conversations ----------
const TASK = 'Add rate limiting to the POST /login endpoint in our Express API. Brute-force attempts are showing up in the logs.';
const C1 = `I'd use **express-rate-limit** with a Redis store so the limit holds across all instances behind the load balancer.

\`\`\`ts
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: req => \`\${req.ip}:\${req.body.email}\`,
  store: new RedisStore({ sendCommand: (...a) => redis.call(...a) }),
});
\`\`\`

Mount it only on \`POST /login\`, and return **429** with a \`Retry-After\` header.`;
const X1 = `The shape is right, but two problems:

1. Keying on \`ip:email\` lets an attacker spray many emails from one IP. Add a second, per-IP limit (say 30 per 15 min).
2. Use \`req.body.email?.toLowerCase()\` or \`A@x.com\` and \`a@x.com\` count separately.

Also reset the per-email counter after a successful login.`;
const C2 = `Agreed on both. Revised plan:

- \`perIp\`: 30 attempts / 15 min, keyed on \`req.ip\`
- \`perAccount\`: 5 attempts / 15 min, keyed on the lower-cased email
- On success, \`perAccount.resetKey(key)\`

Both limiters share the Redis store; \`app.set('trust proxy', 1)\` so \`req.ip\` is the client, not the load balancer.`;
const X2 = 'That covers it. The `trust proxy` note matters behind the load balancer. Ship it.';

const MODEL_SEATS = { drafter: { provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' }, reviewer: { provider: 'codex', model: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' } };
function agreedConversation() {
  let s = { ...view.startConversation(TASK, at(-140)), seats: MODEL_SEATS };
  s = view.receiveMessage(s, ID, { role: 'user', content: TASK }, at(-140));
  s = view.receiveMessage(s, ID, { role: 'drafter', content: C1, verdict: 'continue' }, at(-122));
  s = view.receiveMessage(s, ID, { role: 'reviewer', content: X1, verdict: 'continue' }, at(-96));
  s = view.receiveMessage(s, ID, { role: 'drafter', content: C2, verdict: 'agree' }, at(-74));
  s = view.receiveMessage(s, ID, { role: 'reviewer', content: X2, verdict: 'agree' }, at(-61));
  return { ...view.finishConversation(s, 'completed', at(-60), undefined, { kind: 'agreed', turns: 4 }), bookmarked: true };
}
function streamingConversation() {
  let s = view.startConversation(TASK, at(-58));
  s = view.receiveMessage(s, ID, { role: 'user', content: TASK }, at(-58));
  s = view.receiveMessage(s, ID, { role: 'drafter', content: C1, verdict: 'continue' }, at(-40));
  s = view.receiveMessage(s, ID, { role: 'reviewer', content: X1, verdict: 'continue' }, at(-14));
  return view.receiveProgress(s, 'drafter', { type: 'delta', text: 'Agreed on both. Revised plan:\n\n- `perIp`: 30 attempts / 15 min, keyed on `req.ip`\n- `perAccount`: 5 attempts / 15 min, keyed on the lower' });
}
function continuedConversation() {
  const task = 'Pick up where we left off: is the retry logic in the payment webhook handler safe to ship?';
  let s = { ...view.startConversation(task, at(-30)), origin: { provider: 'claude', sessionId: 'b4e2c6f0-1a2b-4c3d-8e9f-0a1b2c3d4e5f', title: 'Payment webhook retries' } };
  s = view.receiveMessage(s, ID, { role: 'user', content: task }, at(-30));
  s = view.receiveMessage(s, ID, { role: 'drafter', content: 'From our earlier session: retries use exponential backoff with jitter and stop after 5 attempts, and the handler is idempotent on `event.id`. One gap remains: a crash between charging and recording the event could double-charge on retry. I\'d record the event in the same transaction as the charge.', verdict: 'continue' }, at(-12));
  return view.receiveProgress(s, 'reviewer', { type: 'activity', text: 'Reasoning' });
}

// ---------- page pieces ----------
const css = vars => Object.entries(vars).map(([k, v]) => `--vscode-${k}:${v};`).join('');
const providers = require('../dist/providers');
/** The seats sent with every render, as the extension does: names on the chips and the placeholder. */
function seatData(seats) {
  const names = providers.seatNames(seats);
  const seat = s => ({ name: names[s], provider: seats[s].provider, title: s });
  return { seats: { drafter: seat('drafter'), reviewer: seat('reviewer') }, ask: `Ask ${[...new Set([seats.drafter, seats.reviewer].map(x => providers.PROVIDERS[x.provider].name))].join(' and ')}…` };
}
function panelPage(state, theme, options = {}) {
  const t = THEMES[theme];
  const seats = state.status === 'idle' ? (options.seats || providers.DEFAULT_SEATS) : view.seatsOf(state);
  const extra = seatData(seats);
  const stub = `<script nonce="n1">window.acquireVsCodeApi=()=>({postMessage(){}});</script><style nonce="n1">:root{${css(t.vars)}--vscode-font-family:-apple-system,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:"SF Mono",Menlo,monospace}html,body{background:${t.vars['sideBar-background']}}</style>`;
  return view.renderPage('n1', 'file:').replace('<style nonce="n1">', `${stub}<style nonce="n1">`)
    .replace('</body>', `<script nonce="n1">window.postMessage({type:"render",status:${JSON.stringify(state.status)},meta:${JSON.stringify(view.renderMeta(state))},seats:${JSON.stringify(extra.seats)},ask:${JSON.stringify(extra.ask)},effort:${JSON.stringify(seats.drafter.provider === 'codex' || seats.reviewer.provider === 'codex' ? 'Codex medium' : '')},mode:"agreement",maxTurns:10,html:${JSON.stringify(view.renderConversation(state, {}, { ...options, seats }))}},"*");</script></body>`);
}
const ICON = {
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3.5-11 6"/>',
  run: '<path d="M8 5v14l11-7z"/>',
  ext: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><path d="M15 4h5v5"/>',
  turnhuddle: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
};
const svg = (d, size = 24, sw = 1.7) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CODE = [
  ['cm', '// src/routes/auth.ts'],
  ['kw', 'import', 'text', ' { Router } ', 'kw', 'from', 'str', " 'express'", 'text', ';'],
  ['kw', 'import', 'text', ' { loginLimiter } ', 'kw', 'from', 'str', " '../middleware/rateLimit'", 'text', ';'],
  [],
  ['kw', 'export const', 'vr', ' auth', 'text', ' = ', 'fn', 'Router', 'text', '();'],
  [],
  ['vr', 'auth', 'text', '.', 'fn', 'post', 'text', '(', 'str', "'/login'", 'text', ', loginLimiter, ', 'kw', 'async', 'text', ' (req, res) => {'],
  ['text', '  ', 'kw', 'const', 'text', ' { email, password } = req.body;'],
  ['text', '  ', 'kw', 'const', 'vr', ' user', 'text', ' = ', 'kw', 'await', 'text', ' users.', 'fn', 'verify', 'text', '(email, password);'],
  ['text', '  ', 'kw', 'if', 'text', ' (!user) ', 'kw', 'return', 'text', ' res.', 'fn', 'status', 'text', '(', 'num', '401', 'text', ').', 'fn', 'json', 'text', '({ error: ', 'str', "'Invalid login'", 'text', ' });'],
  ['text', '  res.', 'fn', 'json', 'text', '({ token: ', 'fn', 'sign', 'text', '(user) });'],
  ['text', '});']
];
function editor(t) {
  const lines = CODE.map((parts, i) => {
    let html = '';
    for (let j = 0; j < parts.length; j += 2) html += `<span style="color:${parts[j] === 'text' ? t.text : t[parts[j]]}">${parts[j + 1].replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
    return `<div class="ln"><i>${i + 1}</i><span>${html || '&nbsp;'}</span></div>`;
  }).join('');
  return `<div class="tabs"><div class="tab on">${svg(ICON.files, 14)} auth.ts</div><div class="tab">${svg(ICON.files, 14)} rateLimit.ts</div></div><div class="code">${lines}</div>`;
}
function conversationsTree(t, items) {
  const icon = { completed: `<span style="color:${THEMES.dark.vars['testing-iconPassed']}">${svg('<path d="M20 6 9 17l-5-5"/>', 14, 2.4)}</span>`, running: `<span class="spin" style="color:${t.statusFg}">${svg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 14, 2.2)}</span>`, failed: `<span style="color:#f14c4c">${svg('<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>', 14, 2)}</span>` };
  return `<div class="sec"><span>${svg('<path d="m9 6 6 6-6 6"/>', 12, 2.4).replace('m9 6', 'm6 9').replace('6 6-6 6', '6 6 6-6')}</span>CONVERSATIONS<span class="acts">${svg('<path d="M8 5v14l11-7z"/>', 14)}${svg('<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>', 14)}</span></div>
  ${items.map(it => `<div class="row${it.open ? ' open' : ''}">${icon[it.status]}<span class="t">${it.title}</span><span class="d">${it.desc}</span></div>`).join('')}`;
}
function quickPick(t) {
  // Same layout as the extension's picker: the first thing you asked as the title, tool · age · what happens on the line below.
  const rows = [
    ['sparkle', 'Can you check why the payment webhook retries twice after a timeout?', 'Claude Code · 2 h ago · forks the session', true],
    ['terminal', 'Investigate the flaky checkout test in CI and suggest a fix', 'Codex · yesterday · continues the thread', false],
    ['sparkle', 'Plan the migration of the invoices table to UUID keys', 'Claude Code · 3 days ago · forks the session', false],
    ['sparkle', 'Review this PR and list anything that could break refunds', 'Claude Code · 4 days ago · forks the session', false],
    ['folder', 'Show sessions from all folders', '', false]
  ];
  const glyph = { sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', terminal: '<path d="m5 8 4 4-4 4M12 17h7"/>', folder: '<path d="M3 7h6l2 2h10v10H3z"/>' };
  return `<div class="qp"><div class="qp-title">Continue from a CLI session</div><div class="qp-input">Pick the Claude Code or Codex session to continue in Turnhuddle (Esc or click outside to close)</div>
  ${rows.map(([g, title, detail, sel]) => `<div class="qp-row${sel ? ' sel' : ''}">${svg(glyph[g], 16)}<div><div>${title}</div>${detail ? `<div class="qp-detail">${detail}</div>` : ''}</div></div>`).join('')}</div>`;
}
function historyPicker(t) {
  const glyph = { bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>', chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>', cont: '<path d="M8 5v14l11-7z"/>', archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>' };
  const actions = `<span class="qp-acts">${svg('<path d="M6 3h12v18l-6-4-6 4z"/>', 15)}${svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>', 15)}</span>`;
  const row = (g, title, detail, sel) => `<div class="qp-row${sel ? ' sel' : ''}">${svg(glyph[g], 16)}<div style="flex:1"><div>${title}</div>${detail ? `<div class="qp-detail">${detail}</div>` : ''}</div>${sel ? actions : ''}</div>`;
  const sep = label => `<div class="qp-sep">${label}</div>`;
  return `<div class="qp"><div class="qp-title">Conversation history</div><div class="qp-input">Search conversations</div>
  ${sep('Bookmarked')}${row('bookmark', 'Add rate limiting to the POST /login endpoint in our Express API', '2 min ago · 1 round · agreed', true)}${row('bookmark', 'Choose a cache key scheme for product prices', '1 h ago · 2 rounds · agreed', false)}
  ${sep('Recent')}${row('chat', 'Pick up where we left off: is the retry logic safe to ship?', 'just now · 1 round · running · from Claude Code', false)}${row('chat', 'Review the invoice PDF generator', 'yesterday · 1 round · failed', false)}
  <div class="qp-rule"></div>${row('cont', 'Continue from a Claude Code or Codex session…', '', false)}${row('archive', 'Show archived (3)', '', false)}</div>`;
}
function modelPicker(t) {
  const check = '<path d="m5 12 5 5L20 7"/>', edit = '<path d="M4 20h4L19 9l-4-4L4 16z"/>', swap = '<path d="M7 7h12l-3-3M17 17H5l3 3"/>';
  const row = (title, detail, desc, sel, mark) => `<div class="qp-row${sel ? ' sel' : ''}">${mark ? svg(mark, 16) : '<span style="width:16px;display:inline-block"></span>'}<div style="flex:1"><div>${title}${desc ? ` <span class="qp-detail" style="display:inline">${desc}</span>` : ''}</div>${detail ? `<div class="qp-detail">${detail}</div>` : ''}</div></div>`;
  const sep = label => `<div class="qp-sep">${label}</div>`;
  return `<div class="qp"><div class="qp-title">Reviewer: critiques the drafter</div><div class="qp-input">Choose the agent and model for the reviewer seat (now Codex · GPT-6.2-Sol)</div>
  ${sep('Claude Code')}${row('Claude', 'Your Claude Code setting (Opus 5)', 'default model', false)}${row('Claude · Opus', 'Latest Opus', 'opus', false)}${row('Claude · Opus 5.5', 'claude-opus-5-5 · used in recent sessions', '', false)}
  ${sep('Codex')}${row('Codex', 'Your Codex setting (gpt-6-astra)', 'default model', false)}${row('Codex · GPT-6.2-Sol', 'Fast, go-to model for coding and everyday work.', 'gpt-6.2-sol', true, check)}${row('Codex · GPT-6.2-Astra', 'Our most capable model for complex coding and professional work.', 'gpt-6.2-astra', false)}
  ${sep('Gemini CLI · Preview')}${row('Gemini · gemini-2.5-pro', 'Most capable', '', false)}${row('Other Gemini model…', '', '', false, edit)}
  <div class="qp-rule"></div>${row('Swap drafter and reviewer', '', 'Codex · GPT-6.2-Sol drafts, Claude · Opus 5.5 reviews', false, swap)}${row('Effort and other settings…', '', 'Claude inherit · Codex medium', false, '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>')}</div>`;
}
function emptyConversations(t, v) {
  return `<div class="sec"><span>${svg('<path d="m6 9 6 6 6-6"/>', 12, 2.4)}</span>CONVERSATIONS</div>
  <div class="welcome-view"><p>No conversations yet. Type a task in the Chat view below to start one.</p><div class="welcome-btn" style="background:${v['button-background']};color:${v['button-foreground']}">Continue from a Claude Code or Codex Session</div></div>`;
}
function windowPage(theme, panelFile, { tree, overlay, title = 'payments-api', empty } = {}) {
  const t = THEMES[theme].chrome, v = THEMES[theme].vars;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font:13px -apple-system,"Segoe UI",sans-serif;color:${t.text};background:${t.editor}}
  .win{position:absolute;inset:0;display:grid;grid-template-rows:36px 1fr 24px}
  .title{background:${t.title};border-bottom:1px solid ${t.border};display:flex;align-items:center;padding:0 14px;gap:8px}
  .title i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.title i:nth-child(2){background:#febc2e}.title i:nth-child(3){background:#28c840}
  .title span{flex:1;text-align:center;color:${v.descriptionForeground};margin-right:60px}
  .body{display:grid;grid-template-columns:48px ${THREADS}px 1fr ${SIDEBAR}px;min-height:0}
  .act{background:${t.activity};border-right:1px solid ${t.border};display:flex;flex-direction:column;align-items:center;padding-top:6px;gap:4px;color:${t.activityFg}}
  .act div{width:48px;height:46px;display:grid;place-items:center;position:relative}
  .act .on{color:${t.activityActive}}.act .on::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:2px;background:${v.focusBorder}}
  .side{background:${v['sideBar-background']};border-right:1px solid ${t.border};display:flex;flex-direction:column;min-height:0}
  .side-h{height:35px;display:flex;align-items:center;padding:0 20px;font-size:11px;letter-spacing:.04em;color:${v.descriptionForeground}}
  .sec{height:24px;display:flex;align-items:center;gap:4px;padding:0 8px;font-size:11px;font-weight:700;border-top:1px solid ${t.border}}
  .sec .acts{margin-left:auto;display:flex;gap:8px;color:${v.descriptionForeground}}
  .row{height:24px;display:flex;align-items:center;gap:7px;padding:0 10px 0 14px;white-space:nowrap;min-width:0}
  .grp{height:22px;display:flex;align-items:center;gap:4px;padding:0 8px;font-size:11px;font-weight:700;color:${v.descriptionForeground}}
  .side2{background:${v['sideBar-background']};border-left:1px solid ${t.border};display:flex;flex-direction:column;min-height:0}
  .stabs{height:35px;display:flex;align-items:center;gap:4px;padding:0 10px;font-size:12px;color:${v.descriptionForeground}}.stabs b{font-weight:500;color:${t.text};background:${t.quickSel};padding:3px 8px;border-radius:4px}.stabs span{padding:3px 8px}
  .row .t{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}.row svg{flex:none;color:${v.descriptionForeground}}.row .ok{color:${v['testing-iconPassed']}}.row .bad{color:${v['testing-iconFailed']}}.row .d{color:${v.descriptionForeground};font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .row.open{background:${t.quickSel}}
  .welcome-view{padding:6px 20px 16px;font-size:13px}.welcome-view p{margin:0 0 12px;color:${t.text}}
  .welcome-btn{border-radius:4px;padding:6px 10px;text-align:center}
  .chat{flex:1;display:flex;flex-direction:column;min-height:0}
  iframe{flex:1;border:0;width:100%;min-height:0;display:block;background:${v['sideBar-background']}}
  .main{display:flex;flex-direction:column;min-width:0;position:relative}
  .tabs{height:35px;display:flex;background:${t.tabInactive};border-bottom:1px solid ${t.border}}
  .tab{display:flex;align-items:center;gap:6px;padding:0 14px;color:${v.descriptionForeground};border-right:1px solid ${t.border}}
  .tab.on{background:${t.tabActive};color:${t.text};border-top:1px solid ${v.focusBorder}}
  .code{padding:10px 0;font:13.5px/21px "SF Mono",Menlo,monospace}
  .ln{display:flex;white-space:pre}.ln i{flex:none;font-style:normal;width:56px;text-align:right;padding-right:22px;color:${t.gutter}}
  .status{background:${t.status};border-top:1px solid ${t.border};color:${t.statusFg};display:flex;align-items:center;gap:16px;padding:0 12px;font-size:12px}
  .status .th{display:inline-flex;align-items:center;gap:5px}
  .qp{position:absolute;top:44px;left:50%;transform:translateX(-50%);width:600px;background:${t.quick};border:1px solid ${t.border};border-radius:8px;box-shadow:0 8px 28px ${t.shadow};padding:6px;z-index:5}
  .qp-title{text-align:center;font-size:12px;color:${v.descriptionForeground};padding:4px 0 6px}
  .qp-input{border:1px solid ${v.focusBorder};border-radius:4px;padding:6px 8px;color:${v['input-placeholderForeground']};background:${v['input-background']};margin-bottom:6px}
  .qp-row{display:flex;gap:10px;align-items:flex-start;padding:6px 8px;border-radius:4px}
  .qp-row svg{margin-top:2px;flex:none;color:${v.descriptionForeground}}
  .qp-row.sel{background:${t.quickSel}}
  .qp-sep{font-size:11px;color:${v.descriptionForeground};padding:6px 8px 2px;text-align:right;border-top:1px solid ${t.border};margin-top:4px}
  .qp-rule{border-top:1px solid ${t.border};margin:4px 0}
  .qp-acts{display:flex;gap:10px;align-self:center;color:${v.foreground}}
  .qp-desc{color:${v.descriptionForeground};font-size:12px;margin-left:6px}.qp-detail{color:${v.descriptionForeground};font-size:12px;margin-top:2px}
  .spin svg{animation:none}
  </style></head><body><div class="win">
  <div class="title"><i></i><i></i><i></i><span>auth.ts — ${title}</span></div>
  <div class="body">
    <div class="act"><div>${svg(ICON.files)}</div><div>${svg(ICON.search)}</div><div>${svg(ICON.git)}</div><div>${svg(ICON.run)}</div><div>${svg(ICON.ext)}</div><div class="on">${svg(ICON.turnhuddle, 24, 1.8)}</div></div>
    <div class="side"><div class="side-h">TURNHUDDLE: THREADS<span style="margin-left:auto;display:flex;gap:10px">${svg('<path d="M12 5v14M5 12h14"/>', 15)}${svg('<path d="M8 5v14l11-7z"/>', 15)}${svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>', 15)}</span></div>${threadRows(tree || THREADS_DEFAULT, v)}</div>
    <div class="main">${editor(t)}</div>
    <div class="side2"><div class="stabs"><span>Chat</span><b>Turnhuddle</b></div><div class="chat"><iframe src="${panelFile}"></iframe></div></div>
  </div>
  ${overlay || ''}
  <div class="status"><span>⎇ main</span><span>✓ 0 ⚠ 0</span><span style="margin-left:auto" class="th">${svg(ICON.turnhuddle, 13, 2.2)} Turnhuddle</span><span>TypeScript</span></div>
  </div></body></html>`;
}

/** The Threads list (left), as VS Code renders a tree view: an icon per state, the title, then state and age. */
const THREAD_ICON = { running: ['<path d="M12 3a9 9 0 1 0 9 9"/>', ''], agreed: ['<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', 'ok'], bookmark: ['<path d="M6 3h12v18l-6-4-6 4z"/>', ''], failed: ['<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>', 'bad'], done: ['<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>', ''] };
const THREADS_DEFAULT = [
  { group: 'Bookmarked' }, { icon: 'bookmark', title: 'Choose a cache key scheme for prices', desc: 'Agreed · 1h' },
  { group: 'Recent' }, { icon: 'agreed', title: 'Add rate limiting to the POST /login endpoint', desc: 'Agreed · 2m', open: true },
  { icon: 'running', title: 'Is the retry logic safe to ship?', desc: 'now' }, { icon: 'failed', title: 'Review the invoice PDF generator', desc: 'Failed · 1d' }, { icon: 'done', title: 'Name the user-id list variable', desc: '2d' }
];
function threadRows(rows) {
  return rows.map(r => r.group ? `<div class="grp">${svg('<path d="m6 9 6 6 6-6"/>', 12, 2.4)}${r.group.toUpperCase()}</div>` : `<div class="row${r.open ? ' open' : ''}"><span class="${THREAD_ICON[r.icon][1]}">${svg(THREAD_ICON[r.icon][0], 15)}</span><span class="t">${r.title}</span><span class="d">${r.desc}</span></div>`).join('');
}
// ---------- scenes ----------
const TREE = [
  { status: 'running', title: 'Pick up where we left off: is the retry…', desc: 'running · from Claude · just now', open: true },
  { status: 'completed', title: 'Add rate limiting to the POST /login…', desc: 'completed · 1 round · 2 min ago' },
  { status: 'completed', title: 'Choose a cache key scheme for prices', desc: 'completed · 2 rounds · 1 h ago' },
  { status: 'failed', title: 'Review the invoice PDF generator', desc: 'failed · 1 round · yesterday' }
];
const SCENES = {
  chat: { state: agreedConversation, opts: {} },
  streaming: { state: streamingConversation, opts: {} },
  history: { state: continuedConversation, opts: {} },
  continue: { state: () => view.initialState(), opts: { overlay: quickPick } },
  welcome: { state: () => view.initialState(), opts: {}, view: { whatsNew: require('../package.json').version } },
  recents: { state: agreedConversation, opts: { overlay: historyPicker } },
  models: { state: () => view.initialState(), opts: { overlay: modelPicker }, view: { seats: { drafter: { provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' }, reviewer: { provider: 'codex', model: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' } } } }
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const only = (process.env.SCENES ? process.env.SCENES.split(',') : Object.keys(SCENES)).filter(name => SCENES[name]);
for (const name of only) {
  for (const theme of ['light', 'dark']) {
    const scene = SCENES[name];
    const panelFile = `${name}-${theme}-panel.html`;
    fs.writeFileSync(path.join(WORK, panelFile), panelPage(scene.state(), theme, scene.view));
    const opts = { ...scene.opts, overlay: typeof scene.opts.overlay === 'function' ? scene.opts.overlay(THEMES[theme].chrome) : scene.opts.overlay };
    const pageFile = path.join(WORK, `${name}-${theme}.html`);
    fs.writeFileSync(pageFile, windowPage(theme, panelFile, opts));
    const png = path.join(OUT, `${name}-${theme}.png`);
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${SCALE}`, `--window-size=${W},${H}`, '--virtual-time-budget=3000', '--allow-file-access-from-files', `--screenshot=${png}`, `file://${pageFile}`], { stdio: 'pipe' });
    console.log(`${path.relative(ROOT, png)}`);
  }
}
// Social preview (Open Graph) image: 1200 × 630, built from the icon and the light hero shot.
if (!process.env.SCENES || process.env.SCENES.split(',').includes('og')) {
  const icon = fs.readFileSync(path.join(ROOT, 'site', 'icon.png')).toString('base64');
  const shot = fs.readFileSync(path.join(OUT, 'chat-light.png')).toString('base64');
  const og = path.join(WORK, 'og.html');
  fs.writeFileSync(og, `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:-apple-system,"SF Pro Display",sans-serif}
  body{background:radial-gradient(900px 500px at 0% 0%,#f9e3d9,transparent 60%),radial-gradient(800px 500px at 100% 100%,#d9f3ea,transparent 60%),#faf9f7;position:relative}
  .t{position:absolute;left:72px;top:96px;width:520px}
  .t img{width:84px;height:84px;border-radius:20px;box-shadow:0 10px 30px rgba(120,70,40,.25)}
  h1{font-size:64px;line-height:1.02;letter-spacing:-.035em;margin:28px 0 18px;color:#16130f}
  h1 span{background:linear-gradient(100deg,#d97757,#10a37f);-webkit-background-clip:text;color:transparent}
  p{font-size:25px;line-height:1.4;color:#5a544c;margin:0}
  .s{position:absolute;left:640px;top:70px;width:800px;border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(60,40,20,.28);border:1px solid #e7e2da}
  .s img{display:block;width:800px}
  </style></head><body><div class="t"><img src="data:image/png;base64,${icon}"><h1>Claude and Codex, <span>until they agree.</span></h1><p>One VS Code chat. Claude proposes, Codex reviews, both sign off.</p></div><div class="s"><img src="data:image/png;base64,${shot}"></div></body></html>`);
  const png = path.join(OUT, 'og-poster.png');
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', `--screenshot=${png}`, `file://${og}`], { stdio: 'pipe' });
  console.log(path.relative(ROOT, png));
}
fs.rmSync(WORK, { recursive: true, force: true });
