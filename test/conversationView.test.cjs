const { test } = require('node:test');
const assert = require('node:assert/strict');
const view = require('../dist/conversationView');
const { initialState, startConversation, resumeConversation, rounds, receiveMessage, receiveProgress, finishConversation, ConversationStore, renderConversation, renderHeader, renderMeta, renderPage, conversationTitle, currentStage, nextRole, pendingSince, thinkingWord, thinkingLabel, formatSeconds, avatar, escapeHtml, formatTime, formatDuration, THINKING_WORDS, WORD_SECONDS, MAX_TASK_CHARS, TITLE_CHARS } = view;
const t0 = new Date('2026-11-25T10:00:00.000Z');
const at = seconds => new Date(t0.getTime() + seconds * 1000);
const ID = '4652f392-1c6f-4669-8ea1-c3e6a80175ff';
const count = (html, re) => (html.match(re) || []).length;
const fullRound = (task = 'Task') => {
  let state = startConversation(task, t0);
  for (const [role, seconds] of [['user', 0], ['claude', 20], ['codex', 50], ['claude', 85]]) state = receiveMessage(state, ID, { role, content: role === 'user' ? task : `${role} says` }, at(seconds));
  return state;
};
test('publish events build the running state in order with timestamps', () => {
  let state = startConversation('Dedupe strings', t0);
  assert.equal(state.status, 'running'); assert.equal(state.task, 'Dedupe strings'); assert.equal(state.startedAt, t0.toISOString()); assert.equal(state.roundStartedAt, t0.toISOString());
  assert.deepEqual(state.messages, []); assert.equal(state.id, undefined);
  state = receiveMessage(state, ID, { role: 'user', content: 'Dedupe strings' }, at(0));
  state = receiveMessage(state, ID, { role: 'claude', content: 'Proposal' }, at(30));
  state = receiveMessage(state, ID, { role: 'codex', content: 'Critique' }, at(70));
  assert.equal(state.id, ID);
  assert.deepEqual(state.messages.map(m => [m.role, m.content, m.receivedAt]), [
    ['user', 'Dedupe strings', at(0).toISOString()], ['claude', 'Proposal', at(30).toISOString()], ['codex', 'Critique', at(70).toISOString()]
  ]);
  assert.equal(state.status, 'running');
});
test('finishing records status, time and error without touching messages', () => {
  const running = receiveMessage(startConversation('Task', t0), ID, { role: 'user', content: 'Task' }, t0);
  const completed = finishConversation(running, 'completed', at(90));
  assert.equal(completed.status, 'completed'); assert.equal(completed.finishedAt, at(90).toISOString()); assert.equal(completed.error, undefined);
  assert.equal(completed.messages.length, 1);
  const failed = finishConversation(running, 'failed', at(5), 'Error: Cannot run claude');
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Error: Cannot run claude');
  assert.equal(finishConversation(running, 'cancelled', at(5), 'Error: Conversation cancelled.').status, 'cancelled');
  assert.equal(running.status, 'running', 'state is immutable');
});
test('a new start replaces the previous conversation entirely', () => {
  const previous = finishConversation(receiveMessage(startConversation('Old', t0), ID, { role: 'claude', content: 'x' }, t0), 'failed', at(1), 'boom');
  const next = startConversation('New', at(100));
  assert.notEqual(next.id, previous.id); assert.equal(next.error, undefined); assert.equal(next.finishedAt, undefined);
  assert.deepEqual(next.messages, []); assert.equal(next.task, 'New');
});
test('resuming keeps id, task and messages, clears the outcome and starts a new round', () => {
  const failed = finishConversation(fullRound(), 'failed', at(90), 'boom');
  const resumed = resumeConversation(failed, at(200));
  assert.equal(resumed.status, 'running'); assert.equal(resumed.id, ID); assert.equal(resumed.task, 'Task');
  assert.equal(resumed.messages.length, 4); assert.equal(resumed.startedAt, t0.toISOString()); assert.equal(resumed.roundStartedAt, at(200).toISOString());
  assert.ok(!('finishedAt' in resumed)); assert.ok(!('error' in resumed));
  assert.equal(rounds(resumed), 1);
  assert.equal(nextRole(resumed), 'claude', 'a resumed round waits for Claude first');
  assert.equal(pendingSince(resumed), at(200).toISOString(), 'elapsed time counts from the round start, not the previous round');
  const replied = receiveMessage(resumed, ID, { role: 'user', content: 'Follow-up' }, at(201));
  assert.equal(rounds(replied), 2); assert.equal(nextRole(replied), 'claude'); assert.equal(pendingSince(replied), at(201).toISOString());
  const afterClaude = receiveMessage(replied, ID, { role: 'claude', content: 'x' }, at(230));
  assert.equal(nextRole(afterClaude), 'codex');
  assert.equal(nextRole(receiveMessage(afterClaude, ID, { role: 'codex', content: 'y' }, at(240))), 'claude');
  assert.equal(failed.status, 'failed', 'input state untouched');
});
test('store notifies subscribers and supports unsubscribe', () => {
  const store = new ConversationStore();
  assert.deepEqual(store.get(), initialState());
  const seen = [];
  const stop = store.subscribe(state => seen.push(state.status));
  store.set(startConversation('Task', t0));
  store.update(state => finishConversation(state, 'completed', at(1)));
  stop();
  store.set(initialState());
  assert.deepEqual(seen, ['running', 'completed']);
  assert.equal(store.get().status, 'idle');
});
test('title, stage and meta derive from the state', () => {
  assert.equal(conversationTitle(initialState()), 'New conversation');
  assert.equal(conversationTitle(startConversation('  Dedupe\n\nstrings  ', t0)), 'Dedupe strings');
  const long = conversationTitle(startConversation('x'.repeat(200), t0));
  assert.equal(long.length, TITLE_CHARS); assert.ok(long.endsWith('…'));
  let state = startConversation('Task', t0);
  assert.equal(currentStage(initialState()), -1); assert.equal(currentStage(state), 0);
  state = receiveMessage(state, ID, { role: 'user', content: 'Task' }, at(0)); assert.equal(currentStage(state), 0);
  state = receiveMessage(state, ID, { role: 'claude', content: 'a' }, at(1)); assert.equal(currentStage(state), 1);
  state = receiveMessage(state, ID, { role: 'codex', content: 'b' }, at(2)); assert.equal(currentStage(state), 0, 'after Codex it is Claude again');
  assert.equal(currentStage(finishConversation(state, 'completed', at(3))), -1);
  assert.deepEqual(renderMeta(state), { status: 'running', stage: 0, round: 1, turn: 3, roundStartedAt: t0.toISOString(), finishedAt: undefined, startedAt: t0.toISOString() });
  assert.deepEqual(renderMeta(initialState()), { status: 'idle', stage: -1, round: 0, turn: 0, roundStartedAt: undefined, finishedAt: undefined, startedAt: undefined });
});
test('idle render is a welcome screen under the title row, with New disabled and no thread', () => {
  const html = renderConversation(initialState());
  assert.match(html, /^<header class="top status-idle"><span class="title" title="No conversation yet">Turnhuddle<\/span><span class="state"><i class="dot" aria-hidden="true"><\/i>Ready<\/span><button class="icon" type="button" data-command="history" title="Conversations">.*?<\/button><button class="icon" type="button" data-command="new" title="New conversation" disabled>/);
  assert.match(html, /<section class="welcome">/); assert.match(html, /<h1>Claude ↔ Codex<\/h1>/); assert.match(html, /Describe a task below/);
  assert.match(html, /avatar-claude.*avatar-codex/s, 'both marks shown');
  assert.doesNotMatch(html, /<article/); assert.doesNotMatch(html, /thinking/);
  assert.equal(count(html, /<button/g), 2, 'only the Conversations and New buttons');
});
test('title row shows the task excerpt, state, ID tooltip and New only when finished', () => {
  const state = receiveMessage(startConversation('Propose a dedupe function', t0), ID, { role: 'user', content: 'Propose a dedupe function' }, t0);
  let header = renderHeader(state);
  assert.match(header, /^<header class="top status-running"><span class="title" title="Conversation 4652f392-1c6f-4669-8ea1-c3e6a80175ff">Propose a dedupe function<\/span>/);
  assert.match(header, /<i class="dot" aria-hidden="true"><\/i>Running</); assert.match(header, /data-command="new" title="New conversation">/, 'New stays available while running: it opens a fresh conversation, this one keeps running');
  assert.match(header, /data-command="history" title="Conversations">/);
  header = renderHeader(finishConversation(state, 'completed', at(95)));
  assert.match(header, /status-completed/); assert.match(header, /Completed</); assert.doesNotMatch(header, /disabled/);
  assert.match(renderHeader(finishConversation(state, 'cancelled', at(95), 'x')), /Stopped</);
  const full = renderConversation(finishConversation(state, 'completed', at(95)));
  assert.equal(count(full, new RegExp(ID, 'g')), 1, 'full ID appears once, in the tooltip');
});
test('running render: user card, full-width agent messages with author rows and Markdown, live row for the pending agent', () => {
  let state = startConversation('Dedupe <strings>', t0);
  state = receiveMessage(state, ID, { role: 'user', content: 'Dedupe <strings>' }, at(0));
  state = receiveMessage(state, ID, { role: 'claude', content: 'Use a **Set** & keep order:\n\n```ts\n[...new Set(items)]\n```' }, at(30));
  state = receiveMessage(state, ID, { role: 'codex', content: 'Agreed. Add:\n- a null guard\n- a `readonly` input' }, at(60));
  const html = renderConversation(state);
  assert.deepEqual(html.match(/<article class="msg[^"]*"/g), ['<article class="msg msg-user"', '<article class="msg msg-claude"', '<article class="msg msg-codex"', '<article class="msg msg-claude thinking"']);
  assert.match(html, /<article class="msg msg-user"><div class="msg-meta"><time datetime="2026-11-25T10:00:00.000Z">\d{2}:\d{2}<\/time><\/div><div class="user-card"><div class="content"><p>Dedupe &lt;strings&gt;<\/p><\/div><\/div><\/article>/);
  assert.match(html, /<article class="msg msg-claude" data-index="1"><div class="msg-author"><span class="avatar avatar-claude" aria-hidden="true">C<\/span><span class="name">Claude<\/span><time datetime="2026-11-25T10:00:30.000Z">\d{2}:\d{2}<\/time><button class="icon copy" type="button" data-command="copy" data-index="1" title="Copy message">/);
  assert.match(html, /<article class="msg msg-codex" data-index="2">.*<span class="avatar avatar-codex" aria-hidden="true">Cx<\/span><span class="name">Codex<\/span>/s);
  assert.match(html, /<p>Use a <strong>Set<\/strong> &amp; keep order:<\/p><pre class="code" data-lang="ts"><code>\[\.\.\.new Set\(items\)\]<\/code><\/pre>/);
  assert.match(html, /<p>Agreed\. Add:<\/p><ul><li>a null guard<\/li><li>a <code>readonly<\/code> input<\/li><\/ul>/);
  assert.match(html, /<article class="msg msg-claude thinking" data-role="Claude" data-since="2026-11-25T10:01:00.000Z" data-offset="3"><div class="msg-author"><span class="avatar avatar-claude" aria-hidden="true">C<\/span><span class="name">Claude<\/span><span class="thinking-label" aria-live="polite"><i class="spark" aria-hidden="true"><\/i>[A-Z][a-z]+… 0s<\/span><\/div><\/article>/);
  assert.doesNotMatch(html, /Waiting for|turn \d|bubble/);
  assert.equal(count(html, /data-command="copy"/g), 2, 'copy on landed agent messages only');
});
test('live row names the pending agent per round and disappears when not running', () => {
  let state = startConversation('Task', t0);
  let html = renderConversation(state);
  assert.match(html, /<article class="msg msg-claude thinking" data-role="Claude" data-since="2026-11-25T10:00:00.000Z" data-offset="0">/);
  assert.match(html, new RegExp(`${THINKING_WORDS[0]}… 0s`));
  state = receiveMessage(state, ID, { role: 'user', content: 'Task' }, at(0));
  state = receiveMessage(state, ID, { role: 'claude', content: 'a' }, at(20));
  html = renderConversation(state);
  assert.match(html, /msg-codex thinking" data-role="Codex" data-since="2026-11-25T10:00:20.000Z" data-offset="2"/);
  assert.match(html, new RegExp(`${THINKING_WORDS[2]}… 0s`));
  for (const status of ['completed', 'cancelled', 'failed']) {
    const done = renderConversation(finishConversation(state, status, at(90), status === 'completed' ? undefined : 'stopped'));
    assert.doesNotMatch(done, /thinking/, `${status} must not show the live row`);
  }
});
test('streamed progress accumulates into a partial message and is cleared when the message lands', () => {
  let state = receiveMessage(startConversation('Task', t0), ID, { role: 'user', content: 'Task' }, at(0));
  state = receiveProgress(state, 'claude', { type: 'delta', text: 'Use a ' });
  state = receiveProgress(state, 'claude', { type: 'delta', text: '**Set**' });
  assert.deepEqual(state.partial, { role: 'claude', text: 'Use a **Set**' });
  let html = renderConversation(state);
  assert.match(html, /<article class="msg msg-claude thinking streaming"/);
  assert.match(html, /<\/div><div class="content streaming"><p>Use a <strong>Set<\/strong><\/p><\/div><\/article>/);
  assert.match(html, /thinking-label/, 'label stays in the author row');
  state = receiveMessage(state, ID, { role: 'claude', content: 'Use a **Set**' }, at(10));
  assert.ok(!('partial' in state), 'partial cleared by the landed message');
  state = receiveProgress(state, 'codex', { type: 'activity', text: 'Reasoning' });
  assert.deepEqual(state.partial, { role: 'codex', text: '', activity: 'Reasoning' });
  html = renderConversation(state);
  assert.match(html, /<article class="msg msg-codex thinking"/); assert.match(html, /<\/div><p class="activity">Reasoning…<\/p><\/article>/);
  assert.doesNotMatch(html, /content streaming/);
  state = receiveProgress(state, 'codex', { type: 'delta', text: 'Critique' });
  assert.deepEqual(state.partial, { role: 'codex', text: 'Critique', activity: 'Reasoning' });
  assert.doesNotMatch(renderConversation(state), /class="activity"/, 'activity hidden once text streams');
  assert.ok(!('partial' in finishConversation(state, 'failed', at(20), 'x')), 'finishing drops the partial');
  assert.ok(!('partial' in resumeConversation(finishConversation(state, 'completed', at(20)), at(30))));
  assert.equal(receiveProgress(initialState(), 'claude', { type: 'delta', text: 'late' }).partial, undefined, 'progress ignored when not running');
});
test('finished renders show the completion line, duration and notices', () => {
  const state = fullRound();
  const completed = renderConversation(finishConversation(state, 'completed', at(90)));
  assert.match(completed, /status-completed/);
  assert.equal(count(completed, /<article/g), 4, 'task card plus three turns');
  assert.deepEqual(completed.match(/msg msg-(\w+)"/g), ['msg msg-user"', 'msg msg-claude"', 'msg msg-codex"', 'msg msg-claude"']);
  assert.match(completed, /<p class="done">Round 1 complete · 1m 30s<\/p>$/);
  assert.doesNotMatch(completed, /notice/);
  const failed = renderConversation(finishConversation(state, 'failed', at(90), 'claude exited with code 1. <details>'));
  assert.match(failed, /status-failed/); assert.match(failed, /<section class="notice notice-failed"><strong>Failed<\/strong><pre>claude exited with code 1\. &lt;details&gt;<\/pre><\/section>$/);
  const cancelled = renderConversation(finishConversation(state, 'cancelled', at(90), 'Error: Conversation cancelled.'));
  assert.match(cancelled, /status-cancelled/); assert.match(cancelled, /<section class="notice notice-cancelled"><strong>Stopped<\/strong>/);
  assert.doesNotMatch(cancelled, /class="done"/);
});
test('follow-up rounds render user replies as cards with a round divider', () => {
  let state = resumeConversation(finishConversation(fullRound(), 'completed', at(90)), at(200));
  state = receiveMessage(state, ID, { role: 'user', content: 'Follow-up **please**' }, at(201));
  state = receiveMessage(state, ID, { role: 'claude', content: 'claude 2' }, at(230));
  const html = renderConversation(state);
  assert.deepEqual(html.match(/msg msg-(\w+)( thinking)?"/g), ['msg msg-user"', 'msg msg-claude"', 'msg msg-codex"', 'msg msg-claude"', 'msg msg-user"', 'msg msg-claude"', 'msg msg-codex thinking"']);
  assert.equal(count(html, /round-divider/g), 1); assert.match(html, /<div class="round-divider"><span>Round 2<\/span><\/div><article class="msg msg-user">/);
  assert.match(html, /<p>Follow-up <strong>please<\/strong><\/p>/);
  assert.match(html, /msg-codex thinking" data-role="Codex" data-since="2026-11-25T10:03:50.000Z" data-offset="6"/);
  assert.match(html, /data-index="5"/, 'copy index follows the message position');
  const done = renderConversation(finishConversation(receiveMessage(receiveMessage(state, ID, { role: 'codex', content: 'c' }, at(240)), ID, { role: 'claude', content: 'd' }, at(250)), 'completed', at(251)));
  assert.match(done, /Round 2 complete · 51s/); assert.match(done, /data-command="new" title="New conversation">/); assert.doesNotMatch(done, /disabled/);
  assert.match(renderConversation(startConversation('Only task', t0)), /msg-user">.*?<p>Only task<\/p>/s, 'task shown before the first publish event');
});
test('logos replace the built-in glyphs when provided', () => {
  const logos = { claude: 'https://file+.vscode-resource/media/logos/claude.svg', codex: 'https://file+.vscode-resource/media/logos/codex.svg' };
  assert.equal(avatar('claude', logos), `<img class="avatar avatar-claude" src="${logos.claude}" alt="Claude">`);
  assert.equal(avatar('codex', {}), '<span class="avatar avatar-codex" aria-hidden="true">Cx</span>');
  assert.match(avatar('user', logos), /^<span class="avatar avatar-user"/);
  const state = receiveMessage(startConversation('Task', t0), ID, { role: 'claude', content: 'hi' }, at(1));
  const html = renderConversation(state, logos);
  assert.equal(count(html, /<img class="avatar avatar-claude"/g), 1); assert.equal(count(html, /<img class="avatar avatar-codex"/g), 1, 'live row for Codex uses the logo too');
  assert.doesNotMatch(html, /avatar-claude" aria-hidden="true">C</);
  assert.equal(count(renderConversation(initialState(), logos), /<img class="avatar/g), 2, 'welcome marks use the logos');
});
test('nextRole and pendingSince follow the claude, codex, claude relay', () => {
  let state = startConversation('Task', t0);
  assert.equal(nextRole(state), 'claude'); assert.equal(pendingSince(state), t0.toISOString());
  state = receiveMessage(state, ID, { role: 'user', content: 'Task' }, at(1)); assert.equal(nextRole(state), 'claude'); assert.equal(pendingSince(state), at(1).toISOString());
  state = receiveMessage(state, ID, { role: 'claude', content: 'a' }, at(2)); assert.equal(nextRole(state), 'codex');
  state = receiveMessage(state, ID, { role: 'codex', content: 'b' }, at(3)); assert.equal(nextRole(state), 'claude'); assert.equal(pendingSince(state), at(3).toISOString());
  assert.equal(pendingSince(initialState()), undefined);
});
test('thinking words rotate on a fixed cadence from one list and wrap around', () => {
  assert.ok(THINKING_WORDS.length >= 10); assert.equal(new Set(THINKING_WORDS).size, THINKING_WORDS.length, 'no duplicates');
  assert.equal(thinkingWord(0), THINKING_WORDS[0]);
  assert.equal(thinkingWord(WORD_SECONDS - 1), THINKING_WORDS[0]);
  assert.equal(thinkingWord(WORD_SECONDS), THINKING_WORDS[1]);
  assert.equal(thinkingWord(WORD_SECONDS * THINKING_WORDS.length), THINKING_WORDS[0], 'wraps');
  assert.equal(thinkingWord(0, THINKING_WORDS, 5), THINKING_WORDS[5], 'offset shifts the start');
  assert.equal(thinkingWord(-10), THINKING_WORDS[0]); assert.equal(thinkingWord(4, []), '');
  assert.equal(thinkingWord(WORD_SECONDS, ['a', 'b']), 'b'); assert.equal(thinkingWord(2 * WORD_SECONDS, ['a', 'b']), 'a');
});
test('label and seconds helpers are self-contained and format elapsed time', () => {
  assert.equal(thinkingLabel('Pondering', 7), 'Pondering… 7s');
  assert.equal(thinkingLabel('Coagulating', 125.9), 'Coagulating… 2m 5s');
  assert.equal(thinkingLabel('Chasing', -3), 'Chasing… 0s');
  assert.equal(formatSeconds(59.9), '59s'); assert.equal(formatSeconds(61), '1m 1s'); assert.equal(formatSeconds(-1), '0s');
  for (const fn of [thinkingLabel, formatSeconds]) {
    const source = fn.toString();
    assert.doesNotMatch(source, /THINKING_WORDS|WORD_SECONDS|ROLE_LABELS|require|exports/, `${fn.name} must not reference module scope: it is embedded in the webview script`);
    assert.equal(typeof new Function(`return (${source})`)(), 'function');
  }
});
test('page is a chat shell: toolbar composer with send/stop, relay and effort pill, strict CSP, embedded helpers, no inline handlers', () => {
  const html = renderPage('abc123', 'vscode-resource:');
  assert.match(html, /default-src 'none'; img-src vscode-resource: data:; style-src vscode-resource: 'nonce-abc123'; script-src 'nonce-abc123';/);
  assert.match(html, /<script nonce="abc123">/); assert.match(html, /<style nonce="abc123">/);
  assert.match(html, /<body data-status="idle">/); assert.match(html, /<main id="root"><\/main>/);
  assert.match(html, new RegExp(`<textarea id="task" rows="1" maxlength="${MAX_TASK_CHARS}" placeholder="Describe a task`));
  assert.match(html, /<span id="run-text">Ready<\/span>/); assert.match(html, /<span class="relay" id="relay"[^>]*><span data-stage="0">Claude<\/span><i>⇄<\/i><span data-stage="1">Codex<\/span><span id="turn" class="turn"><\/span><\/span>/);
  assert.match(html, /<button id="effort" class="pill" type="button" data-command="settings"/);
  assert.match(html, /<button id="stop" class="round-btn" type="button" data-command="cancel"/); assert.match(html, /<button id="send" class="round-btn" type="button" data-command="send"/);
  assert.doesNotMatch(html, /data-command="start"/, 'no Start button');
  assert.ok(html.includes(`const words = ${JSON.stringify(THINKING_WORDS)};`), 'word list comes from THINKING_WORDS');
  assert.ok(html.includes(`const wordSeconds = ${WORD_SECONDS};`));
  assert.ok(html.includes(`const thinkingLabel = ${thinkingLabel.toString()};`)); assert.ok(html.includes(`const formatSeconds = ${formatSeconds.toString()};`));
  for (const command of ["{ command: 'send', text }", "{ command: 'cancel' }", "{ command: 'new' }", "{ command: 'history' }", "{ command: 'copy', index: Number(button.dataset.index) }", "{ command: 'settings' }", "{ command: 'ready' }"]) assert.ok(html.includes(`vscode.postMessage(${command})`), `posts ${command}`);
  assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(html, /setInterval\(tick, 1000\)/); assert.match(html, /clearInterval\(timer\)/);
  assert.doesNotMatch(html, /onclick=|onkeydown=/);
});
test('helpers escape, format and tolerate bad input', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.match(formatTime(t0.toISOString()), /^\d{2}:\d{2}$/);
  assert.equal(formatTime('not a date'), '');
  assert.equal(formatDuration(t0.toISOString(), at(42).toISOString()), '42s');
  assert.equal(formatDuration(t0.toISOString(), at(125).toISOString()), '2m 5s');
  assert.equal(formatDuration(at(5).toISOString(), t0.toISOString()), '');
});
test('title row shows where a continued conversation came from', () => {
  const origin = { provider: 'claude', sessionId: 'orig-1', title: 'Earlier <chat>' };
  const state = { ...startConversation('Continue please', t0), origin };
  const header = renderHeader(state);
  assert.match(header, /<span class="origin" title="Continued from Claude session orig-1: Earlier &lt;chat&gt;">from Claude<\/span>/);
  assert.doesNotMatch(renderHeader(startConversation('Plain', t0)), /class="origin"/);
  assert.doesNotMatch(renderHeader({ ...initialState(), origin }), /class="origin"/, 'not on the welcome screen');
  assert.match(renderHeader({ ...state, origin: { ...origin, provider: 'codex' } }), /from Codex</);
});
const { statusLabel, turnsInRound } = view;
test('verdicts and the round outcome are rendered, and alternate-turn rounds drive the live row', () => {
  let state = receiveMessage(startConversation('Task', t0), ID, { role: 'user', content: 'Task' }, at(0));
  state = receiveMessage(state, ID, { role: 'claude', content: 'Proposal', verdict: 'continue' }, at(10));
  state = receiveMessage(state, ID, { role: 'codex', content: 'Issues', verdict: 'continue' }, at(20));
  state = receiveMessage(state, ID, { role: 'claude', content: 'Revised', verdict: 'agree' }, at(30));
  assert.equal(state.messages[1].verdict, 'continue'); assert.equal(state.messages[3].verdict, 'agree'); assert.ok(!('verdict' in state.messages[0]));
  assert.equal(turnsInRound(state), 3); assert.equal(nextRole(state), 'codex'); assert.equal(currentStage(state), 1);
  assert.deepEqual(renderMeta(state).turn, 4, 'the running turn is the next one');
  let html = renderConversation(state);
  assert.match(html, /<span class="name">Claude<\/span><span class="verdict verdict-continue" title="Wants further changes">continues<\/span><time/);
  assert.match(html, /<span class="name">Claude<\/span><span class="verdict verdict-agree" title="Considers the current recommendation final">agrees<\/span>/);
  assert.match(html, /msg-codex thinking" data-role="Codex" data-since="2026-11-25T10:00:30.000Z" data-offset="4"/, 'a fourth turn waits on Codex');
  state = receiveMessage(state, ID, { role: 'codex', content: 'Final', verdict: 'agree' }, at(40));
  assert.equal(nextRole(state), 'claude', 'a fifth turn would be Claude again');
  const agreed = finishConversation(state, 'completed', at(41), undefined, { kind: 'agreed', turns: 4 });
  assert.deepEqual(agreed.outcome, { kind: 'agreed', turns: 4 }); assert.equal(statusLabel(agreed), 'Agreed');
  html = renderConversation(agreed);
  assert.match(html, /<header class="top status-completed outcome-agreed">/); assert.match(html, /<\/i>Agreed</);
  assert.match(html, /<p class="done done-agreed">Round 1 · both agreed after 4 turns · 41s<\/p>$/);
  assert.deepEqual(renderMeta(agreed).outcome, { kind: 'agreed', turns: 4 }); assert.equal(renderMeta(agreed).turn, 4);
  const limit = finishConversation(state, 'completed', at(41), undefined, { kind: 'limit', turns: 10 });
  assert.equal(statusLabel(limit), 'No agreement'); assert.match(renderConversation(limit), /<p class="done done-limit">Round 1 · no agreement after 10 turns \(limit reached\) · 41s<\/p>$/);
  const fixed = finishConversation(state, 'completed', at(41), undefined, { kind: 'fixed', turns: 3 });
  assert.equal(statusLabel(fixed), 'Completed'); assert.match(renderConversation(fixed), /<p class="done done-fixed">Round 1 complete · 41s<\/p>$/);
  assert.match(renderConversation(finishConversation(state, 'completed', at(41))), /<p class="done">Round 1 complete · 41s<\/p>$/, 'no outcome recorded (older saves)');
  const resumed = resumeConversation(agreed, at(100));
  assert.ok(!('outcome' in resumed), 'a new round clears the previous outcome'); assert.equal(statusLabel(resumed), 'Running');
  assert.equal(renderMeta(resumed).turn, 1);
  assert.equal(statusLabel(finishConversation(state, 'failed', at(41), 'x')), 'Failed');
});
test('page shows the alternating relay with a turn counter', () => {
  const html = renderPage('n', 'src:');
  assert.match(html, /<span data-stage="0">Claude<\/span><i>⇄<\/i><span data-stage="1">Codex<\/span><span id="turn" class="turn"><\/span>/);
  assert.match(html, /'· turn ' \+ meta\.turn/); assert.match(html, /maxTurns/);
});
