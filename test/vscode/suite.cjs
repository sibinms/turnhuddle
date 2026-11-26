// Runs inside the Extension Development Host (see run.cjs). Drives Turnhuddle through its commands and
// verifies the behaviour the README promises: CLI check, cancellation, invalid executable errors and a
// complete three-turn conversation, then a follow-up round on it, the saved history (list, file, reopen, archive, restore) and two
// conversations running at once, a conversation continued from a real Claude Code session, and an agreement-mode round, with no workspace changes and no leftover
// child processes. The sidebar's
// state is asserted after every step through the exported API and the hidden `turnhuddle.getState` command,
// and its change events are recorded during the conversation to prove the view updates live.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const TASK = 'Propose a TypeScript function that removes duplicate strings from an array while preserving first-occurrence order. Discuss edge cases and the tests you would write. Do not create or modify files. Keep each response under 200 words.';
const FOLLOW_UP = 'Thanks. Now name the single most important test case from your discussion and why, in under 80 words. Do not create or modify files.';
const SHORT_TASKS = ['In under 60 words, name one edge case for a function that removes duplicate strings from an array. Do not create or modify files.', 'In under 60 words, name one performance consideration for a function that removes duplicate strings from an array. Do not create or modify files.'];
const log = (...parts) => console.log('[turnhuddle-vscode]', ...parts);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Turnhuddle CLI processes spawned by this extension host (VS Code itself spawns other children, e.g. language servers).
const children = () => execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n')
  .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  .filter(([, , ppid, command]) => Number(ppid) === process.pid && cliPaths.some(cli => command.startsWith(cli))).map(([, pid, , command]) => ({ pid: Number(pid), command }));
let cliPaths = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const snapshot = dir => fs.readdirSync(dir, { recursive: true }).sort().map(name => { const stat = fs.statSync(path.join(dir, name)); return `${name}:${stat.size}:${stat.mtimeMs}`; }).join('\n');
const waitFor = async (predicate, timeoutMs, what) => { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = predicate(); if (value) return value; await sleep(250); } throw new Error(`Timed out waiting for ${what}`); };
exports.run = async () => {
  const report = { started: new Date().toISOString(), steps: {} };
  const save = () => { if (process.env.TURNHUDDLE_REPORT) fs.writeFileSync(process.env.TURNHUDDLE_REPORT, JSON.stringify(report, null, 2)); };
  process.on('unhandledRejection', reason => log('unhandled rejection:', reason));
  try { await steps(report, save); } catch (error) { report.error = String(error && error.stack || error); save(); console.error('[turnhuddle-vscode] FAILED:', report.error); throw error; }
};
const steps = async (report, save) => {
  const config = vscode.workspace.getConfiguration('turnhuddle');
  const claudePath = config.get('claudePath'); const codexPath = config.get('codexPath');
  cliPaths = [claudePath, codexPath];
  const extension = vscode.extensions.getExtension('turnhuddle.turnhuddle');
  assert.ok(extension, 'turnhuddle.turnhuddle extension not found');
  await extension.activate();
  report.extensionPath = extension.extensionPath; report.version = extension.packageJSON.version;
  const api = extension.exports;
  assert.ok(api && typeof api.getState === 'function', 'exported API missing');
  const events = []; const partials = [];
  const subscription = api.onDidChangeState(state => {
    const last = events[events.length - 1];
    if (!last || last.status !== state.status || last.messages.length !== state.messages.length) events.push({ at: new Date().toISOString(), status: state.status, messages: state.messages.map(m => m.role) });
    if (state.partial) partials.push({ at: new Date().toISOString(), turn: state.messages.length, role: state.partial.role, chars: state.partial.text.length, activity: state.partial.activity });
  });
  const sameState = async () => { const state = api.getState(); assert.deepEqual(await vscode.commands.executeCommand('turnhuddle.getState'), state, 'command and API disagree'); return state; };
  assert.deepEqual(await sameState(), { status: 'idle', messages: [] });
  // 0. Sidebar view resolves when focused (the webview document itself cannot be read from the extension host)
  log('step 0: sidebar view');
  await vscode.commands.executeCommand('turnhuddle.conversation.focus');
  await waitFor(() => api.isViewResolved(), 15000, 'sidebar webview to resolve');
  report.steps.view = { resolved: api.isViewResolved(), visible: api.isViewVisible() };
  log('view:', report.steps.view);
  if (process.env.TURNHUDDLE_EXPECT_INSTALLED) assert.ok(!extension.extensionPath.endsWith('driver') && extension.extensionPath.includes('extensions'), `expected installed extension, got ${extension.extensionPath}`);
  log(`extension ${report.version} at ${extension.extensionPath}`);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.ok(vscode.workspace.isTrusted, 'workspace must be trusted');
  const before = snapshot(folder);
  // 0b. Update check against the real GitHub API (the command's silent form returns the result without notifications)
  log('step 0b: update check');
  const update = await vscode.commands.executeCommand('turnhuddle.checkForUpdates', { silent: true });
  report.steps.updates = update;
  log('update check:', JSON.stringify(update));
  assert.equal(update.current, report.version);
  assert.ok(['available', 'current', 'none'].includes(update.status), `update check failed: ${JSON.stringify(update)}`);
  // 1. CLI check
  log('step 1: check');
  const check = await vscode.commands.executeCommand('turnhuddle.check');
  log('check:', check);
  assert.equal(check.length, 3);
  assert.match(check[0], /^claude: \d+\.\d+\.\d+/); assert.match(check[1], /^codex: codex-cli \d+/);
  report.steps.check = check;
  // 1b. With both paths left at their defaults the CLIs are found automatically (here: bundled in the vendor extensions,
  // since neither is on PATH on this machine) and a real round runs with them.
  log('step 1b: automatic CLI detection');
  await config.update('claudePath', 'claude', vscode.ConfigurationTarget.Global);
  await config.update('codexPath', 'codex', vscode.ConfigurationTarget.Global);
  try {
    const detected = await vscode.commands.executeCommand('turnhuddle.check');
    log('detected:', detected);
    assert.match(detected[0], /^claude: \d+\.\d+\.\d+.*\((on PATH|installed|from your shell PATH|bundled with the VS Code extension): \//);
    assert.match(detected[1], /^codex: codex-cli \d+.*\((on PATH|installed|from your shell PATH|bundled with the VS Code extension): \//);
    assert.equal(vscode.workspace.getConfiguration('turnhuddle').get('claudePath'), 'claude', 'settings left untouched');
    const auto = await vscode.commands.executeCommand('turnhuddle.start', { task: 'Reply with one short sentence naming a good variable name for a list of unique emails. Do not create or modify files.', source: 'sidebar' });
    report.steps.autoDetect = { detected, status: auto.status, error: auto.error, roles: auto.messages.map(m => m.role) };
    assert.equal(auto.status, 'completed', auto.error);
    assert.deepEqual(auto.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude']);
  } finally {
    await config.update('claudePath', claudePath, vscode.ConfigurationTarget.Global);
    await config.update('codexPath', codexPath, vscode.ConfigurationTarget.Global);
  }
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  // 2. Cancellation mid-invocation
  log('step 2: cancellation'); save();
  assert.equal(await vscode.commands.executeCommand('turnhuddle.cancel'), false, 'cancel with nothing running returns false');
  const pending = vscode.commands.executeCommand('turnhuddle.start', { task: TASK });
  const child = await waitFor(() => children().find(c => c.command.startsWith(claudePath)), 60000, 'claude child process');
  assert.ok(codexPath, 'codexPath configured');
  log(`claude child pid ${child.pid}; cancelling`);
  await sleep(2000);
  assert.equal(await vscode.commands.executeCommand('turnhuddle.cancel'), true);
  const cancelled = await pending;
  log('cancelled result:', cancelled.status, cancelled.error);
  assert.equal(cancelled.status, 'cancelled'); assert.match(cancelled.error, /cancelled/);
  assert.deepEqual(cancelled.messages.map(m => m.role), ['user'], 'no agent turns after cancellation');
  await waitFor(() => !alive(child.pid), 5000, 'claude child to exit');
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  const cancelledState = await sameState();
  assert.equal(cancelledState.status, 'cancelled'); assert.equal(cancelledState.task, TASK); assert.equal(cancelledState.id, cancelled.id);
  assert.deepEqual(cancelledState.messages.map(m => m.role), ['user']); assert.match(cancelledState.error, /cancelled/);
  assert.ok(cancelledState.startedAt <= cancelledState.finishedAt, 'cancel timestamps ordered');
  report.steps.cancel = { childPid: child.pid, status: cancelled.status, error: cancelled.error, state: cancelledState };
  // 3. Invalid executable path
  log('step 3: invalid executable path'); save();
  await config.update('claudePath', '/nonexistent/turnhuddle-claude', vscode.ConfigurationTarget.Global);
  try {
    const failed = await vscode.commands.executeCommand('turnhuddle.start', { task: TASK });
    log('invalid path result:', failed.status, failed.error);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /Cannot run \/nonexistent\/turnhuddle-claude: spawn .*ENOENT/);
    const failedState = await sameState();
    assert.equal(failedState.status, 'failed'); assert.equal(failedState.error, failed.error); assert.deepEqual(failedState.messages.map(m => m.role), ['user']);
    report.steps.invalidPath = { status: failed.status, error: failed.error, state: failedState };
  } finally { await config.update('claudePath', claudePath, vscode.ConfigurationTarget.Global); }
  assert.equal(vscode.workspace.getConfiguration('turnhuddle').get('claudePath'), claudePath, 'claudePath restored');
  // 3b. Over-long preset tasks are refused before anything starts
  const tooLong = await vscode.commands.executeCommand('turnhuddle.start', { task: 'x'.repeat(32001), source: 'sidebar' });
  assert.equal(tooLong.status, 'skipped'); assert.equal(api.getState().status, 'failed', 'state untouched by a refused task');
  // 4. Full three-turn conversation after cancellation, started the way the chat panel starts it
  log('step 4: full conversation'); save();
  // The failed conversation from step 3 is still open; typing now would continue it. Close it as the panel's New button does, then send the task
  // the way the composer does (turnhuddle.reply starts a new conversation when none is open; the webview itself cannot be driven from the extension host).
  assert.equal(await vscode.commands.executeCommand('turnhuddle.clear'), true);
  assert.equal(api.getState().status, 'idle');
  const startedAt = Date.now(); events.length = 0; partials.length = 0;
  const running = vscode.commands.executeCommand('turnhuddle.reply', { message: TASK, source: 'sidebar' });
  await waitFor(() => api.getState().status === 'running', 5000, 'sidebar to show running');
  const seenRunning = { messages: api.getState().messages.length, pid: children()[0] && children()[0].pid };
  const result = await running;
  subscription.dispose();
  const finalState = await sameState();
  report.steps.conversation = { status: result.status, id: result.id, error: result.error, durationMs: Date.now() - startedAt, messages: result.messages, seenRunning, state: finalState, events };
  for (const message of result.messages) log(`[${result.id}] ${message.role} (${message.content.length} chars):\n${message.content}\n`);
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude']);
  assert.equal(result.messages[0].content, TASK);
  for (const message of result.messages.slice(1)) assert.ok(message.content.trim().length > 20, `${message.role} response too short`);
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  assert.equal(snapshot(folder), before, 'workspace files changed during the conversation');
  // Sidebar state after the conversation, and the live sequence of updates it rendered on the way
  assert.equal(finalState.status, 'completed'); assert.equal(finalState.id, result.id); assert.equal(finalState.task, TASK); assert.equal(finalState.error, undefined);
  assert.deepEqual(finalState.messages.map(m => ({ role: m.role, content: m.content })), result.messages, 'sidebar messages match the command result');
  const times = [finalState.startedAt, ...finalState.messages.map(m => m.receivedAt), finalState.finishedAt];
  for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] <= times[i], `timestamps out of order: ${times.join(' > ')}`);
  for (const time of times) assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(events.map(e => `${e.status}:${e.messages.join(',')}`), ['running:', 'running:user', 'running:user,claude', 'running:user,claude,codex', 'running:user,claude,codex,claude', 'completed:user,claude,codex,claude'], 'sidebar updated once per arrival');
  // Streaming: Claude's text grew in the panel before the message landed; Codex (no deltas in this CLI version) at least reported activity or its message.
  const claudeStream = partials.filter(p => p.role === 'claude'); const codexStream = partials.filter(p => p.role === 'codex');
  assert.ok(claudeStream.length >= 5, `expected several Claude partial updates, got ${claudeStream.length}`);
  assert.ok(claudeStream.some(p => p.chars > 0 && p.chars < result.messages[1].content.length), 'Claude text was visible while incomplete');
  assert.ok(claudeStream.every((p, i, a) => i === 0 || a[i - 1].turn !== p.turn || p.chars >= a[i - 1].chars), 'partial text only grows within a turn');
  assert.deepEqual([...new Set(claudeStream.map(p => p.turn))], [1, 3], 'Claude streamed in its two turns of the round');
  assert.ok(codexStream.length >= 1, 'Codex produced at least one progress update');
  report.steps.conversation.streaming = { claudeUpdates: claudeStream.length, claudeFirstAt: claudeStream[0] && claudeStream[0].at, claudeMaxChars: Math.max(0, ...claudeStream.map(p => p.chars)), codexUpdates: codexStream.length, codexActivities: [...new Set(codexStream.map(p => p.activity).filter(Boolean))] };
  log('streaming:', JSON.stringify(report.steps.conversation.streaming));
  assert.ok(api.isViewResolved(), 'sidebar view still resolved');
  log('sidebar events:', events.map(e => `${e.status}(${e.messages.length})@${e.at}`).join(' '));
  // 5. Follow-up round on the same conversation, the way the composer sends a reply
  log('step 5: follow-up round'); save();
  const replyEvents = []; const replySubscription = api.onDidChangeState(state => { const key = `${state.status}:${state.messages.map(m => m.role[0]).join('')}`; if (replyEvents[replyEvents.length - 1] !== key) replyEvents.push(key); });
  const replyStartedAt = Date.now();
  const reply = await vscode.commands.executeCommand('turnhuddle.reply', { message: FOLLOW_UP, source: 'sidebar' });
  replySubscription.dispose();
  const replyState = await sameState();
  report.steps.reply = { status: reply.status, id: reply.id, error: reply.error, durationMs: Date.now() - replyStartedAt, messages: reply.messages, state: replyState, events: replyEvents };
  for (const message of reply.messages) log(`[${reply.id}] ${message.role} (${message.content.length} chars):\n${message.content}\n`);
  assert.equal(reply.status, 'completed', reply.error);
  assert.equal(reply.id, result.id, 'reply continues the same conversation');
  assert.deepEqual(reply.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude'], 'one new round returned');
  assert.equal(reply.messages[0].content, FOLLOW_UP);
  assert.equal(replyState.status, 'completed'); assert.equal(replyState.id, result.id); assert.equal(replyState.task, TASK); assert.equal(replyState.partial, undefined, 'no partial text left after completion');
  assert.deepEqual(replyState.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude', 'user', 'claude', 'codex', 'claude'], 'panel shows both rounds');
  assert.deepEqual(replyEvents, ['running:uccc', 'running:ucccu', 'running:ucccuc', 'running:ucccucc', 'running:ucccuccc', 'completed:ucccuccc'], 'panel updated once per arrival in the second round');
  assert.ok(replyState.roundStartedAt > replyState.messages[3].receivedAt && replyState.roundStartedAt <= replyState.messages[4].receivedAt, 'round start sits between the rounds');
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  assert.equal(snapshot(folder), before, 'workspace files changed during the follow-up');
  // 6. History: the conversation is listed, saved to disk, can be closed, reopened, archived and restored
  log('step 6: history'); save();
  let list = await vscode.commands.executeCommand('turnhuddle.listSessions');
  assert.deepEqual(list, api.listSessions());
  assert.deepEqual(list.map(e => e.status), ['completed', 'failed', 'cancelled', 'completed'], 'newest first: the conversation, then the invalid-path, cancelled and auto-detect ones from steps 3, 2 and 1b');
  const entry = list[0];
  assert.equal(entry.id, result.id); assert.equal(entry.status, 'completed'); assert.equal(entry.rounds, 2); assert.equal(entry.messages, 8); assert.equal(entry.archived, false);
  assert.equal(entry.cwd, folder); assert.ok(entry.file && entry.file.startsWith(api.historyDir()), `file ${entry.file} under ${api.historyDir()}`);
  await waitFor(() => fs.existsSync(entry.file), 5000, 'conversation file on disk');
  await sleep(300);
  const saved = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  assert.equal(saved.id, result.id); assert.equal(saved.status, 'completed'); assert.equal(saved.messages.length, 8); assert.equal(saved.partial, undefined); assert.equal(saved.task, TASK);
  assert.equal(await vscode.commands.executeCommand('turnhuddle.clear'), true);
  assert.deepEqual(await sameState(), { status: 'idle', messages: [] }, 'New shows the welcome state');
  assert.equal((await vscode.commands.executeCommand('turnhuddle.listSessions')).length, 4, 'New keeps the conversations in the list');
  assert.equal(await vscode.commands.executeCommand('turnhuddle.open', result.id), true);
  const reopened = await sameState();
  assert.equal(reopened.id, result.id); assert.equal(reopened.status, 'completed'); assert.equal(reopened.messages.length, 8); assert.equal(reopened.task, TASK);
  assert.equal(await vscode.commands.executeCommand('turnhuddle.open', 'no-such-id'), false);
  assert.equal(await vscode.commands.executeCommand('turnhuddle.archive', result.id), true);
  list = await vscode.commands.executeCommand('turnhuddle.listSessions');
  assert.equal(list.find(e => e.id === result.id).archived, true); assert.equal(list[list.length - 1].id, result.id, 'archived conversations are listed last');
  assert.equal((await sameState()).status, 'idle', 'archiving the open conversation closes it');
  await sleep(300); assert.equal(JSON.parse(fs.readFileSync(entry.file, 'utf8')).archived, true, 'archive flag saved');
  assert.ok(fs.existsSync(entry.file), 'archiving never deletes the file');
  assert.equal(await vscode.commands.executeCommand('turnhuddle.restore', result.id), true);
  list = await vscode.commands.executeCommand('turnhuddle.listSessions');
  assert.equal(list.find(e => e.id === result.id).archived, false); assert.equal(list[0].id, result.id, 'restoring makes it the most recent again');
  report.steps.history = { entry, file: entry.file, savedMessages: saved.messages.length, historyDir: api.historyDir() };
  // 7. Two conversations run at the same time
  log('step 7: concurrent conversations'); save();
  const concurrentStartedAt = Date.now();
  const pair = SHORT_TASKS.map(task => vscode.commands.executeCommand('turnhuddle.start', { task, source: 'sidebar' }));
  await waitFor(() => api.runningIds().length === 2, 10000, 'two conversations running');
  const runningIds = api.runningIds();
  assert.equal((await vscode.commands.executeCommand('turnhuddle.listSessions')).filter(s => s.status === 'running').length, 2, 'both listed as running');
  const both = await Promise.all(pair);
  report.steps.concurrent = { durationMs: Date.now() - concurrentStartedAt, runningIds, results: both.map(r => ({ status: r.status, id: r.id, error: r.error, roles: r.messages.map(m => m.role) })) };
  for (const r of both) { assert.equal(r.status, 'completed', r.error); assert.deepEqual(r.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude']); }
  assert.notEqual(both[0].id, both[1].id); assert.deepEqual(new Set(runningIds), new Set(both.map(r => r.id)));
  assert.equal(api.runningIds().length, 0);
  list = await vscode.commands.executeCommand('turnhuddle.listSessions');
  assert.equal(list.length, 6); assert.deepEqual(list.slice(0, 2).map(s => s.status), ['completed', 'completed']);
  assert.equal(await vscode.commands.executeCommand('turnhuddle.refreshSessions'), 6, 'reloading from disk finds the same six, no duplicates');
  assert.equal((await vscode.commands.executeCommand('turnhuddle.listSessions')).length, 6);
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  assert.equal(snapshot(folder), before, 'workspace files changed during the concurrent conversations');
  // 8. Continue from a real Claude Code session: create one directly with the CLI in the workspace folder, then continue it in Turnhuddle
  log('step 8: continue from a Claude Code session'); save();
  const codeword = `PELICAN-${Date.now() % 10000}`;
  const created = JSON.parse(execFileSync(claudePath, ['-p', '--permission-mode', 'plan', '--output-format', 'json', '--effort', 'low'], { cwd: folder, input: `Remember the codeword ${codeword}. Reply with only: noted.`, timeout: 120000 }).toString());
  assert.ok(created.session_id, 'claude -p reported a session id');
  const vendor = await vscode.commands.executeCommand('turnhuddle.listVendorSessions');
  assert.deepEqual(vendor, await api.listVendorSessions());
  const listed = vendor.find(s => s.provider === 'claude' && s.id === created.session_id);
  assert.ok(listed, `new session listed for this folder (got ${vendor.length} sessions)`);
  assert.match(listed.title, /codeword/); assert.equal(listed.cwd, fs.realpathSync(folder), 'the CLI records the resolved path of the workspace folder');
  const continueStartedAt = Date.now();
  const continued = await vscode.commands.executeCommand('turnhuddle.continueFrom', { provider: 'claude', sessionId: created.session_id, title: listed.title, source: 'sidebar',
    message: 'State the codeword I gave you earlier in your first sentence, then propose in under 100 words how a TypeScript app should keep such a secret out of its source. Do not create or modify files.' });
  const continuedState = await sameState();
  report.steps.continueFrom = { sessionId: created.session_id, codeword, status: continued.status, id: continued.id, error: continued.error, durationMs: Date.now() - continueStartedAt, messages: continued.messages, state: { origin: continuedState.origin, agentSessions: continuedState.agentSessions }, listed };
  for (const message of continued.messages) log(`[${continued.id}] ${message.role} (${message.content.length} chars):\n${message.content}\n`);
  assert.equal(continued.status, 'completed', continued.error);
  assert.deepEqual(continued.messages.map(m => m.role), ['user', 'claude', 'codex', 'claude']);
  assert.ok(continued.messages[1].content.includes(codeword), `Claude recalled the codeword from the resumed session: ${continued.messages[1].content.slice(0, 200)}`);
  assert.deepEqual(continuedState.origin, { provider: 'claude', sessionId: created.session_id, title: listed.title });
  assert.ok(continuedState.agentSessions && continuedState.agentSessions.claude && continuedState.agentSessions.claude !== created.session_id, 'Claude continued in a forked session, not the original');
  assert.ok(continuedState.agentSessions.codex, 'Codex thread id recorded for later turns');
  assert.equal((await vscode.commands.executeCommand('turnhuddle.listSessions')).find(s => s.id === continued.id).rounds, 1);
  assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
  assert.equal(snapshot(folder), before, 'workspace files changed during the continued conversation');
  // 9. Agreement mode: the agents alternate until both say AGREE back to back (or the cap), verdicts are shown and the outcome recorded
  log('step 9: agreement round'); save();
  assert.equal(config.get('roundMode'), 'fixed');
  await config.update('roundMode', 'agreement', vscode.ConfigurationTarget.Global);
  await config.update('maxTurnsPerRound', 6, vscode.ConfigurationTarget.Global);
  try {
    assert.equal(await vscode.commands.executeCommand('turnhuddle.clear'), true);
    const agreementStartedAt = Date.now(); const agreementTurns = [];
    const sub = api.onDidChangeState(state => { const n = state.messages.filter(m => m.role !== 'user').length; if (agreementTurns[agreementTurns.length - 1] !== n) agreementTurns.push(n); });
    const agreed = await vscode.commands.executeCommand('turnhuddle.reply', { message: 'Recommend a name for a function that removes duplicate strings from an array while keeping first-occurrence order. Keep each reply under 80 words. Agree as soon as the other agent’s recommendation is reasonable. Do not create or modify files.', source: 'sidebar' });
    sub.dispose();
    const agreedState = await sameState();
    report.steps.agreement = { status: agreed.status, id: agreed.id, error: agreed.error, durationMs: Date.now() - agreementStartedAt, messages: agreed.messages, outcome: agreedState.outcome, turnsSeen: agreementTurns };
    for (const message of agreed.messages) log(`[${agreed.id}] ${message.role} ${message.verdict ? `(${message.verdict})` : ''}:\n${message.content}\n`);
    assert.equal(agreed.status, 'completed', agreed.error);
    const agents = agreed.messages.filter(m => m.role !== 'user');
    assert.ok(agents.length >= 2 && agents.length <= 6, `between 2 and 6 agent turns, got ${agents.length}`);
    assert.deepEqual(agents.map(m => m.role), agents.map((_, i) => i % 2 === 0 ? 'claude' : 'codex'), 'agents alternate');
    assert.ok(agents.every(m => m.verdict === 'agree' || m.verdict === 'continue'), `every agent turn carries a verdict: ${JSON.stringify(agents.map(m => m.verdict))}`);
    assert.ok(agents.every(m => !/VERDICT\s*:/i.test(m.content)), 'the verdict line is stripped from the shown text');
    assert.ok(agreedState.outcome && ['agreed', 'limit'].includes(agreedState.outcome.kind), `outcome recorded: ${JSON.stringify(agreedState.outcome)}`);
    assert.equal(agreedState.outcome.turns, agents.length);
    if (agreedState.outcome.kind === 'agreed') { assert.equal(agents[agents.length - 1].verdict, 'agree'); assert.equal(agents[agents.length - 2].verdict, 'agree'); }
    else assert.equal(agents.length, 6);
    assert.deepEqual(agreedState.messages.map(m => m.verdict), agreed.messages.map(m => m.verdict), 'panel state carries the verdicts');
    assert.equal(children().length, 0, `leftover children: ${JSON.stringify(children())}`);
    assert.equal(snapshot(folder), before, 'workspace files changed during the agreement round');
  } finally { await config.update('roundMode', 'fixed', vscode.ConfigurationTarget.Global); await config.update('maxTurnsPerRound', undefined, vscode.ConfigurationTarget.Global); }
  report.finished = new Date().toISOString(); report.ok = true; save();
  log('all checks passed');
};
