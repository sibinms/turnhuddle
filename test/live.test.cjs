const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionPool, liveAdapter, deferred } = require('../dist/live');
const { CodexLiveSession, codexActivity } = require('../dist/codexLive');
const { AcpLiveSession, refusePermission } = require('../dist/acpLive');
const { ClaudeLiveSession, READ_ONLY_TOOLS } = require('../dist/claudeLive');
const { relay } = require('../dist/bridge');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'turnhuddle-live-'));
/** A fake agent: a Node script that reads JSON lines and runs `handler(message, send)`; logs every received message. */
const fakeAgent = (handler) => {
  const dir = tmp(); const file = path.join(dir, 'agent.cjs');
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs'); const log = ${JSON.stringify(path.join(dir, 'log.jsonl'))};\nconst send = m => process.stdout.write(JSON.stringify(m) + '\\n');\nconst state = {};\nconst handle = ${handler.toString()};\nlet buf = '';\nprocess.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); fs.appendFileSync(log, line + '\\n'); handle(m, send, state, process.argv.slice(2)); } });\n`, { mode: 0o755 });
  return { file, log: () => fs.existsSync(path.join(dir, 'log.jsonl')) ? fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
};

// ---------- Codex app-server ----------
const codexServer = (m, send, state) => {
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId || 'thr-1' }, model: 'gpt-x' } });
  else if (m.method === 'turn/start') {
    state.n = (state.n || 0) + 1; const turn = `turn-${state.n}`; const text = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: turn, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: 'thr-1', turn: { id: turn } } });
    if (/slow/.test(text)) { state.slow = turn; return; }
    send({ method: 'item/started', params: { threadId: 'thr-1', turnId: turn, item: { type: 'reasoning', id: 'r' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: turn, itemId: 'a1', delta: 'Hello ' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'other', turnId: 'x', itemId: 'zz', delta: 'NOT MINE' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: turn, itemId: 'a1', delta: 'there' } });
    send({ method: 'item/completed', params: { threadId: 'thr-1', turnId: turn, item: { type: 'agentMessage', id: 'a1', text: 'Hello there' } } });
    if (/fail/.test(text)) send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: turn, status: 'failed', error: { message: 'usage limit reached' } } } });
    else send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: turn, status: 'completed' } } });
  } else if (m.method === 'turn/steer') send({ id: m.id, result: { turnId: m.params.expectedTurnId } });
  else if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: m.params.turnId, status: 'interrupted' } } }); }
};
test('Codex live session: one app-server thread, streamed turns, steering and interrupt', async () => {
  const agent = fakeAgent(codexServer);
  const sessions = [];
  const s = new CodexLiveSession(agent.file, { provider: 'codex', executable: agent.file, cwd: tmp(), model: 'gpt-x', onSession: id => sessions.push(id) });
  const progress = [];
  assert.equal(await s.turn('Task', p => progress.push(p), { effort: 'low', model: 'gpt-y' }), 'Hello there');
  assert.deepEqual(progress, [{ type: 'activity', text: 'Reasoning' }, { type: 'delta', text: 'Hello ' }, { type: 'delta', text: 'there' }], 'other threads are ignored');
  assert.deepEqual(sessions, ['thr-1']); assert.equal(s.sessionId, 'thr-1');
  await assert.rejects(s.turn('please fail', () => {}, {}), /Codex reported an error: usage limit reached/);
  const slow = s.turn('slow one', () => {}, {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal(s.busy, true); assert.equal(await s.steer('also consider X'), true);
  await s.interrupt();
  await assert.rejects(slow, /Conversation cancelled/);
  assert.equal(s.busy, false); assert.equal(await s.steer('late'), false, 'nothing to steer between turns');
  const log = agent.log();
  assert.deepEqual(log.map(m => m.method).filter(Boolean), ['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/start', 'turn/start', 'turn/steer', 'turn/interrupt']);
  const start = log.find(m => m.method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never'); assert.equal(start.model, 'gpt-x');
  const firstTurn = log.find(m => m.method === 'turn/start').params;
  assert.deepEqual([firstTurn.threadId, firstTurn.input[0].text, firstTurn.effort, firstTurn.model], ['thr-1', 'Task', 'low', 'gpt-y']);
  assert.equal(log.find(m => m.method === 'turn/steer').params.expectedTurnId, 'turn-3');
  assert.ok(!('jsonrpc' in log[0]), 'app-server lines carry no jsonrpc field');
  s.close();
  const resumed = new CodexLiveSession(agent.file, { provider: 'codex', executable: agent.file, cwd: tmp(), resume: 'thr-1' });
  assert.equal(await resumed.turn('again', () => {}, {}), 'Hello there'); resumed.close();
  assert.ok(agent.log().some(m => m.method === 'thread/resume' && m.params.threadId === 'thr-1'), 'a stored thread is resumed');
  assert.equal(codexActivity({ type: 'commandExecution', command: 'ls -la' }), 'Running ls -la'); assert.equal(codexActivity({ type: 'agentMessage' }), undefined);
});
test('a crashed agent fails the running turn with its last output', async () => {
  const agent = fakeAgent((m, send) => { if (m.method === 'initialize') send({ id: m.id, result: {} }); else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't' } } }); else if (m.method === 'turn/start') { process.stderr.write('boom: not logged in'); process.exit(3); } });
  const s = new CodexLiveSession(agent.file, { provider: 'codex', executable: agent.file, cwd: tmp() });
  await assert.rejects(s.turn('x', () => {}, {}), /exit code 3.*boom: not logged in/s);
  await assert.rejects(new CodexLiveSession('/nonexistent/codex', { provider: 'codex', executable: '/nonexistent/codex', cwd: tmp() }).turn('x', () => {}, {}), /Cannot run \/nonexistent\/codex/);
});

// ---------- ACP ----------
const acpAgent = (m, send, state, args) => {
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'acp-1' } });
  else if (m.method === 'session/load') send({ jsonrpc: '2.0', id: m.id, result: null });
  else if (m.method === 'session/prompt') {
    state.prompt = m.id;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', title: 'read_file' } } });
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: 'acp-1', options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Gemini says hi (${args.join(' ')})` } } } });
    if (!/slow/.test(m.params.prompt[0].text)) send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  } else if (m.method === 'session/cancel') send({ jsonrpc: '2.0', id: state.prompt, result: { stopReason: 'cancelled' } });
};
test('ACP live session: new session, streamed chunks, permission requests refused, cancel', async () => {
  const agent = fakeAgent(acpAgent);
  const s = new AcpLiveSession('gemini', ['--experimental-acp'], { provider: 'gemini', executable: agent.file, cwd: tmp(), model: 'gemini-2.5-pro' }, 'Gemini');
  const progress = [];
  assert.equal(await s.turn('Task', p => progress.push(p), {}), 'Gemini says hi (--experimental-acp --model gemini-2.5-pro)');
  assert.deepEqual(progress[0], { type: 'activity', text: 'Using read_file' });
  const log = agent.log();
  assert.ok(log.every(m => m.jsonrpc === '2.0'), 'ACP messages are JSON-RPC 2.0');
  assert.deepEqual(log.find(m => m.id === 900).result, { outcome: { outcome: 'selected', optionId: 'no' } }, 'the reject option is chosen');
  assert.deepEqual(log.find(m => m.method === 'initialize').params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(await s.steer('x'), false, 'ACP has no steering');
  const slow = s.turn('slow', () => {}, {}); await new Promise(r => setTimeout(r, 100));
  await s.interrupt(); await assert.rejects(slow, /cancelled/);
  s.close();
  const loaded = new AcpLiveSession('gemini', [], { provider: 'gemini', executable: agent.file, cwd: tmp(), resume: 'acp-1' });
  await loaded.turn('again', () => {}, {}); loaded.close();
  assert.ok(agent.log().some(m => m.method === 'session/load' && m.params.sessionId === 'acp-1'));
  assert.deepEqual(refusePermission([{ optionId: 'a', kind: 'allow_always' }]), { outcome: { outcome: 'cancelled' } });
});

// ---------- Claude Agent SDK ----------
/** A stand-in for the SDK's query(): reads user messages from the prompt iterable and answers each with a streamed result. */
const fakeQuery = (calls) => ({ query: ({ prompt, options }) => {
  calls.push({ options });
  const out = []; let waiting; let interrupted = false;
  const push = m => { if (waiting) { const w = waiting; waiting = undefined; w({ value: m, done: false }); } else out.push(m); };
  (async () => {
    push({ type: 'system', subtype: 'init', session_id: options.resume && !options.forkSession ? options.resume : 'cl-1' });
    for await (const message of prompt) {
      calls.push({ message });
      const text = message.message.content;
      push({ type: 'stream_event', session_id: 'cl-1', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } });
      push({ type: 'stream_event', session_id: 'cl-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Re: ' } } });
      if (/slow/.test(text)) { await new Promise(r => setTimeout(r, 200)); if (interrupted) { push({ type: 'result', subtype: 'error_during_execution', errors: ['[ede_diagnostic] result_type=user'] }); interrupted = false; continue; } }
      push({ type: 'result', subtype: /fail/.test(text) ? 'error_max_turns' : 'success', is_error: /fail/.test(text), result: `Re: ${text}` });
    }
  })();
  const iterator = { next: () => out.length ? Promise.resolve({ value: out.shift(), done: false }) : new Promise(r => { waiting = r; }) };
  return { [Symbol.asyncIterator]: () => iterator, interrupt: async () => { interrupted = true; calls.push({ interrupt: true }); }, setModel: async m => calls.push({ setModel: m }), close: () => calls.push({ close: true }) };
} });
test('Claude live session: one SDK query for the whole thread, plan mode, your own CLI, read-only tools', async () => {
  const calls = []; const ids = [];
  const s = new ClaudeLiveSession({ provider: 'claude', executable: '/opt/claude', cwd: '/w', model: 'opus', effort: 'high', onSession: id => ids.push(id) }, async () => fakeQuery(calls));
  const progress = [];
  assert.equal(await s.turn('one', p => progress.push(p), { model: 'opus' }), 'Re: one');
  assert.deepEqual(progress, [{ type: 'activity', text: 'Using Read' }, { type: 'delta', text: 'Re: ' }]);
  assert.equal(await s.turn('two', () => {}, { model: 'opus' }), 'Re: two');
  assert.equal(calls.filter(c => c.options).length, 1, 'one query serves every turn');
  const o = calls[0].options;
  assert.deepEqual([o.cwd, o.pathToClaudeCodeExecutable, o.permissionMode, o.includePartialMessages, o.model, o.effort], ['/w', '/opt/claude', 'plan', true, 'opus', 'high']);
  assert.deepEqual(await o.canUseTool('Read', {}), { behavior: 'allow' });
  assert.equal((await o.canUseTool('Edit', {})).behavior, 'deny'); assert.equal((await o.canUseTool('Bash', {})).behavior, 'deny');
  assert.ok(READ_ONLY_TOOLS.has('Grep') && !READ_ONLY_TOOLS.has('Write'));
  assert.deepEqual(ids, ['cl-1']); assert.equal(s.sessionId, 'cl-1');
  await s.turn('three', () => {}, { model: 'haiku' });
  assert.ok(calls.some(c => c.setModel === 'haiku'), 'a new model is set on the live session');
  await assert.rejects(s.turn('please fail', () => {}, {}), /Claude reported an error/);
  const steered = s.turn('slow', () => {}, {});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await s.steer('consider Y'), true);
  assert.equal(await steered, 'Re: consider Y', 'the reply is the answer that took the mid-turn message into account');
  const slow = s.turn('slow again', () => {}, {});
  await new Promise(r => setTimeout(r, 50));
  await s.interrupt();
  await assert.rejects(slow, /cancelled/);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(calls.some(c => c.message && c.message.priority === 'next' && c.message.message.content === 'consider Y'), 'steering queues the message right after the current answer');
  s.close(); assert.ok(calls.some(c => c.close));
  await assert.rejects(s.turn('after close', () => {}, {}), /Session closed/);
  const forked = [];
  const f = new ClaudeLiveSession({ provider: 'claude', executable: '/opt/claude', cwd: '/w', resume: 'orig', fork: true }, async () => fakeQuery(forked));
  await f.turn('hi', () => {}, {});
  assert.deepEqual([forked[0].options.resume, forked[0].options.forkSession], ['orig', true]); f.close();
});

// ---------- pool, adapter and relay ----------
const fakeSession = (provider, log) => {
  let busy = false; const gate = deferred();
  return { provider, sessionId: `${provider}-s`, get busy() { return busy; },
    turn: async (text, onProgress) => { busy = true; log.push(['turn', provider, text]); onProgress({ type: 'delta', text: 'x' }); if (/hang/.test(text)) await gate.promise; busy = false; return `${provider} reply`; },
    steer: async t => { log.push(['steer', t]); return busy; }, interrupt: async () => { log.push(['interrupt', provider]); gate.reject(new Error('Conversation cancelled.')); }, close: () => log.push(['close', provider]) };
};
test('the pool keeps one session per thread and seat, replaces it on a provider change, and closes idle ones', async () => {
  const log = [];
  const pool = new SessionPool({ codex: () => fakeSession('codex', log), claude: () => fakeSession('claude', log) }, 50);
  const spec = { provider: 'codex', executable: 'x', cwd: '/w' };
  const a = pool.acquire('t1', 'reviewer', spec);
  assert.equal(pool.acquire('t1', 'reviewer', spec), a, 'same thread and seat: same session');
  assert.notEqual(pool.acquire('t2', 'reviewer', spec), a, 'another thread gets its own');
  const b = pool.acquire('t1', 'reviewer', { ...spec, provider: 'claude' });
  assert.equal(b.provider, 'claude'); assert.deepEqual(log, [['close', 'codex']], 'the old provider\'s session is closed');
  assert.equal(pool.supports('gemini'), false); assert.throws(() => pool.acquire('t1', 'drafter', { ...spec, provider: 'gemini' }), /No live session support/);
  pool.release('t1', 'reviewer'); await new Promise(r => setTimeout(r, 80));
  assert.equal(pool.get('t1', 'reviewer'), undefined, 'idle sessions close');
  pool.closeAll(); assert.equal(pool.size(), 0);
});
test('liveAdapter stops the turn on cancel and on timeout, and checks the reply size', async () => {
  const log = [];
  const s = fakeSession('codex', log);
  const controller = new AbortController();
  const hung = liveAdapter(s, {}, { timeoutMs: 5000, maxBytes: 100, signal: controller.signal, name: 'Codex' })('hang', () => {});
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(hung, /Conversation cancelled/); assert.ok(log.some(l => l[0] === 'interrupt'));
  await assert.rejects(liveAdapter(fakeSession('codex', []), {}, { timeoutMs: 30, maxBytes: 100, name: 'Codex' })('hang', () => {}), /Codex timed out after 0s/);
  await assert.rejects(liveAdapter(fakeSession('codex', []), {}, { timeoutMs: 1000, maxBytes: 3, name: 'Codex' })('hi', () => {}), /Codex's reply is 11 bytes/);
});
test('messages sent mid-round join the history before the next turn, and context can change per turn', async () => {
  const prompts = []; let queue = ['wait, also handle nulls'];
  const result = await relay({ id: 'x', history: [] }, 'Task', { drafter: async p => { prompts.push(p); return 'draft'; }, reviewer: async p => { prompts.push(p); return 'review'; } }, () => {}, undefined, {
    takeQueued: () => { const q = queue; queue = []; return q; },
    contextFor: seat => seat === 'drafter' && prompts.length > 0 ? 'delta' : 'replay'
  });
  assert.deepEqual(result.history.map(m => [m.role, m.content, !!m.steer]), [['user', 'Task', false], ['user', 'wait, also handle nulls', true], ['drafter', 'draft', false], ['reviewer', 'review', false], ['drafter', 'draft', false]]);
  assert.match(prompts[0], /wait, also handle nulls/); assert.match(prompts[2], /New messages since your last turn:\n\[\{"from":"the reviewer","content":"review"\}\]$/, 'the drafter\'s third turn is a delta');
});
test('a mid-turn message Claude folds into its current answer does not leave the turn waiting', async () => {
  const calls = [];
  const merging = { query: ({ prompt }) => {
    const out = []; let waiting;
    const push = m => { if (waiting) { const w = waiting; waiting = undefined; w({ value: m, done: false }); } else out.push(m); };
    (async () => { push({ type: 'system', subtype: 'init', session_id: 'm-1' }); for await (const message of prompt) { calls.push(message); if (message.priority === 'next') continue; await new Promise(r => setTimeout(r, 60)); push({ type: 'result', subtype: 'success', result: 'ZEBRA answer covering both' }); } })();
    return { [Symbol.asyncIterator]: () => ({ next: () => out.length ? Promise.resolve({ value: out.shift(), done: false }) : new Promise(r => { waiting = r; }) }), interrupt: async () => {}, setModel: async () => {}, close: () => {} };
  } };
  const previous = ClaudeLiveSession.GRACE_MS; ClaudeLiveSession.GRACE_MS = 50;
  try {
    const s = new ClaudeLiveSession({ provider: 'claude', executable: '/opt/claude', cwd: '/w' }, async () => merging);
    const turn = s.turn('question', () => {}, {});
    await new Promise(r => setTimeout(r, 20));
    assert.equal(await s.steer('add ZEBRA'), true);
    assert.equal(await turn, 'ZEBRA answer covering both'); assert.equal(s.busy, false);
    s.close();
  } finally { ClaudeLiveSession.GRACE_MS = previous; }
});
