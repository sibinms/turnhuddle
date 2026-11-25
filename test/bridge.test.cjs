const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, converse } = require('../dist/bridge');
const limits = { cwd: process.cwd(), timeoutMs: 3000, maxBytes: 1024 };
test('three turns preserve task, critique and conversation ID', async () => {
  const events = []; let calls = 0;
  const result = await converse('Original task', {
    claude: async prompt => { assert.match(prompt, /Original task/); if (calls++) assert.match(prompt, /Critique/); return 'Proposal'; },
    codex: async prompt => { assert.match(prompt, /Proposal/); return 'Critique'; }
  }, (id, message) => events.push({ id, message }));
  assert.deepEqual(result.history.map(m => m.role), ['user', 'claude', 'codex', 'claude']);
  assert.equal(new Set(events.map(e => e.id)).size, 1);
});
test('failure stops relay', async () => {
  let called = false;
  await assert.rejects(converse('Task', { claude: async () => { throw Error('failed'); }, codex: async () => { called = true; return ''; } }, () => {}), /failed/);
  assert.equal(called, false);
});
test('stdin is passed literally without a shell', async () => {
  const input = '$(touch unwanted) `echo hi`';
  assert.equal(await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], input, limits), input);
});
test('timeout terminates child', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '', { ...limits, timeoutMs: 100 }), /timed out/);
});
test('output limit includes stderr', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("a".repeat(2048))'], '', limits), /exceeded/);
});
test('non-zero exit fails', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(2)'], '', limits), /code 2/);
});
test('cancellation terminates running process', async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '', { ...limits, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /cancelled/);
});
test('missing CLI reports actionable error', async () => {
  await assert.rejects(run('/nonexistent/bridge-cli', [], '', limits), /Cannot run/);
});
const { parseClaudeResult, claudeAdapter, codexAdapter, summarize, CLAUDE_ARGS, CODEX_ARGS } = require('../dist/bridge');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fakeCli = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnhuddle-fake-'));
  const file = path.join(dir, 'fake-cli.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};
test('non-zero exit preserves a bounded stderr tail', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("x".repeat(9000) + "\\n\\u001b[31mNot logged in\\u001b[0m\\n", () => process.exit(1))'], '', { ...limits, maxBytes: 65536 }), error => {
    assert.match(error.message, /code 1/);
    assert.match(error.message, /Last output: …x+ Not logged in$/);
    assert.ok(error.message.length < 600, `message too long: ${error.message.length}`);
    assert.doesNotMatch(error.message, /\u001b/);
    return true;
  });
});
test('non-zero exit without stderr still points at authentication', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], '', limits), /code 3\. Check CLI authentication in a terminal\.$/);
});
test('summarize keeps either end and collapses whitespace', () => {
  assert.equal(summarize('  a\n\n b\tc  '), 'a b c');
  assert.equal(summarize('abcdef', 3), '…def');
  assert.equal(summarize('abcdef', 3, 'start'), 'abc…');
});
test('parseClaudeResult accepts a successful result', () => {
  assert.equal(parseClaudeResult('{"type":"result","is_error":false,"result":"Proposal"}'), 'Proposal');
});
test('parseClaudeResult reports CLI errors with their text', () => {
  assert.throws(() => parseClaudeResult('{"is_error":true,"result":"Not logged in · Please run /login"}'), /Claude reported an error: Not logged in · Please run \/login\. Check CLI authentication/);
  assert.throws(() => parseClaudeResult('{"is_error":false,"subtype":"error_max_turns"}'), /no result text \(error_max_turns\)/);
  assert.throws(() => parseClaudeResult('Welcome to Claude'), /did not return JSON\. Output began: Welcome to Claude/);
  assert.throws(() => parseClaudeResult('"just a string"'), /not a result object/);
});
const { parseClaudeStreamLine, parseCodexStreamLine, lineSplitter, claudeArgs, codexArgs } = require('../dist/bridge');
const claudeLines = [
  '{"type":"system","subtype":"init"}',
  '{"type":"stream_event","event":{"type":"message_start"}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Prop"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"osal"}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Proposal"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Proposal"}'
];
test('parseClaudeStreamLine yields text deltas and the final result, ignores the rest', () => {
  assert.deepEqual(claudeLines.map(parseClaudeStreamLine), [undefined, undefined, { kind: 'delta', text: 'Prop' }, undefined, { kind: 'delta', text: 'osal' }, undefined, { kind: 'result', text: 'Proposal' }]);
  assert.deepEqual(parseClaudeStreamLine('{"type":"result","is_error":true,"result":"Not logged in"}'), { kind: 'error', message: 'Claude reported an error: Not logged in. Check CLI authentication and usage limits.' });
  assert.deepEqual(parseClaudeStreamLine('{"type":"result","subtype":"error_max_turns"}'), { kind: 'error', message: 'Claude returned no result text (error_max_turns).' });
  assert.equal(parseClaudeStreamLine('not json'), undefined); assert.equal(parseClaudeStreamLine('"string"'), undefined);
});
const codexLines = [
  '{"type":"thread.started","thread_id":"t1"}', '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i0","type":"reasoning"}}',
  '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thought"}}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la src"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Critique"}}',
  '{"type":"turn.completed","usage":{"output_tokens":3}}'
];
test('parseCodexStreamLine yields the agent message, activity notes for other items, and errors', () => {
  assert.deepEqual(codexLines.map(parseCodexStreamLine), [{ kind: 'session', id: 't1' }, undefined, { kind: 'activity', text: 'Reasoning' }, undefined, { kind: 'activity', text: 'Running ls -la src' }, { kind: 'message', text: 'Critique' }, undefined]);
  assert.deepEqual(parseCodexStreamLine('{"type":"error","message":"rate limited"}'), { kind: 'error', message: 'Codex reported an error: rate limited.' });
  assert.deepEqual(parseCodexStreamLine('{"type":"turn.failed","error":{"message":"boom"}}'), { kind: 'error', message: 'Codex reported an error: boom.' });
  assert.equal(parseCodexStreamLine('{"type":"item.updated","item":{"type":"agent_message","text":"partial"}}'), undefined, 'only completed agent messages count');
});
test('lineSplitter reassembles lines across chunks and flushes the tail', () => {
  const seen = []; const splitter = lineSplitter(line => seen.push(line));
  splitter.push('{"a":1}\n{"b"'); splitter.push(':2}\n\n{"c":'); splitter.push('3}'); splitter.flush();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
test('effort flags are added only when not inherited', () => {
  assert.deepEqual(claudeArgs(), CLAUDE_ARGS); assert.deepEqual(claudeArgs('inherit'), CLAUDE_ARGS);
  assert.deepEqual(claudeArgs('low'), [...CLAUDE_ARGS, '--effort', 'low']);
  assert.deepEqual(codexArgs(), [...CODEX_ARGS, '-']);
  assert.deepEqual(codexArgs('medium'), [...CODEX_ARGS, '-c', 'model_reasoning_effort="medium"', '-']);
  assert.deepEqual(CLAUDE_ARGS, ['-p', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.deepEqual(CODEX_ARGS, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--json']);
});
const jsonlCli = (lines, delayMs = 0.05) => fakeCli(`cat >/dev/null\n${lines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'${delayMs ? `; sleep ${delayMs}` : ''}`).join('\n')}`);
test('claude adapter streams deltas as they arrive and returns the final result', async () => {
  const progress = []; const timeline = [];
  const cli = jsonlCli(claudeLines);
  const text = await claudeAdapter(cli, { ...limits, maxBytes: 65536 }, 'low')('prompt', p => { progress.push(p); timeline.push(Date.now()); });
  assert.equal(text, 'Proposal');
  assert.deepEqual(progress, [{ type: 'delta', text: 'Prop' }, { type: 'delta', text: 'osal' }]);
  assert.ok(timeline[1] - timeline[0] >= 30, `deltas arrived together (${timeline[1] - timeline[0]} ms apart); streaming is not live`);
  const argsCli = fakeCli(`printf '%s\\n' "$@" >&2; cat >/dev/null; printf '%s\\n' '${claudeLines[6]}'`);
  assert.equal(await claudeAdapter(argsCli, limits)('prompt'), 'Proposal');
});
test('claude adapter falls back to streamed text without a result line and surfaces CLI errors', async () => {
  assert.equal(await claudeAdapter(jsonlCli(claudeLines.slice(0, 5), 0), limits)('p'), 'Proposal');
  await assert.rejects(claudeAdapter(jsonlCli(['{"type":"result","is_error":true,"result":"Not logged in"}'], 0), limits)('p'), /Claude reported an error: Not logged in/);
  await assert.rejects(claudeAdapter(fakeCli('cat >/dev/null; echo Welcome'), limits)('p'), /Claude returned no result\. Output began: Welcome/);
});
test('codex adapter reports activity, then the message, and ignores stderr progress', async () => {
  const progress = [];
  const cli = jsonlCli(codexLines, 0);
  const noisy = fakeCli(`echo "progress: $*" >&2\n${codexLines.map(l => `printf '%s\\n' '${l}'`).join('\n')}`);
  assert.equal(await codexAdapter(cli, { ...limits, maxBytes: 65536 }, 'medium')('Proposal', p => progress.push(p)), 'Critique');
  assert.deepEqual(progress, [{ type: 'activity', text: 'Reasoning' }, { type: 'activity', text: 'Running ls -la src' }, { type: 'delta', text: 'Critique' }]);
  assert.equal(await codexAdapter(noisy, { ...limits, maxBytes: 65536 })('Proposal'), 'Critique');
  const two = jsonlCli(['{"type":"item.completed","item":{"type":"agent_message","text":"One"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"Two"}}'], 0);
  assert.equal(await codexAdapter(two, limits)('p'), 'One\n\nTwo');
  await assert.rejects(codexAdapter(jsonlCli(['{"type":"error","message":"quota"}'], 0), limits)('p'), /Codex reported an error: quota/);
  await assert.rejects(codexAdapter(fakeCli('cat >/dev/null; echo plain text'), limits)('p'), /Codex returned no message\. Output began: plain text/);
});
const { relay, roundInstruction } = require('../dist/bridge');
test('relay forwards per-turn progress with the conversation id and role', async () => {
  const seen = [];
  const adapters = { claude: async (p, on) => { on({ type: 'delta', text: 'a' }); on({ type: 'delta', text: 'b' }); return 'ab'; }, codex: async (p, on) => { on({ type: 'activity', text: 'Reasoning' }); return 'c'; } };
  const result = await converse('Task', adapters, () => {}, (id, role, progress) => seen.push([id, role, progress.type, progress.text]));
  assert.ok(seen.every(x => x[0] === result.id), 'progress carries the conversation id');
  assert.deepEqual(seen.map(x => x.slice(1)), [['claude', 'delta', 'a'], ['claude', 'delta', 'b'], ['codex', 'activity', 'Reasoning'], ['claude', 'delta', 'a'], ['claude', 'delta', 'b']]);
  await converse('Task', adapters, () => {});
});
test('relay continues the same conversation with the full history and follow-up instructions', async () => {
  const prompts = [];
  const adapters = { claude: async p => { prompts.push(['claude', p]); return 'Claude says'; }, codex: async p => { prompts.push(['codex', p]); return 'Codex says'; } };
  const first = await converse('Task', adapters, () => {});
  const events = [];
  const second = await relay(first, 'Follow-up', adapters, (id, m) => events.push([id, m.role]));
  assert.equal(second.id, first.id);
  assert.deepEqual(second.history.map(m => m.role), ['user', 'claude', 'codex', 'claude', 'user', 'claude', 'codex', 'claude']);
  assert.equal(second.history[4].content, 'Follow-up');
  assert.deepEqual(events, [[first.id, 'user'], [first.id, 'claude'], [first.id, 'codex'], [first.id, 'claude']]);
  assert.equal(first.history.length, 4, 'input conversation is not mutated');
  assert.match(prompts[0][1], /Analyse the task/); assert.match(prompts[3][1], /latest message in light of the whole conversation/);
  assert.match(prompts[4][1], /Review Claude’s latest response/); assert.match(prompts[5][1], /Respond to Codex’s critique/);
  assert.match(prompts[5][1], /"Follow-up"/); assert.match(prompts[5][1], /"Task"/, 'history replayed in full');
});
test('roundInstruction depends on position in the round', () => {
  assert.match(roundInstruction('claude', [{ role: 'user', content: 't' }]), /Analyse/);
  assert.match(roundInstruction('claude', [{ role: 'user', content: 't' }, { role: 'claude', content: 'a' }, { role: 'codex', content: 'b' }]), /critique/);
  assert.match(roundInstruction('claude', [{ role: 'user', content: 't' }, { role: 'claude', content: 'a' }, { role: 'codex', content: 'b' }, { role: 'claude', content: 'c' }, { role: 'user', content: 'u' }]), /latest message/);
  assert.match(roundInstruction('codex', []), /Review/);
});
const { buildPrompt, CODEX_RESUME_ARGS } = require('../dist/bridge');
test('resume options add the CLI resume flags and report the session id', async () => {
  assert.deepEqual(claudeArgs('inherit', { resume: 'abc' }), [...CLAUDE_ARGS, '--resume', 'abc']);
  assert.deepEqual(claudeArgs('low', { resume: 'abc', fork: true }), [...CLAUDE_ARGS, '--effort', 'low', '--resume', 'abc', '--fork-session']);
  assert.deepEqual(codexArgs('inherit', { resume: 't1' }), [...CODEX_RESUME_ARGS, 't1', '-']);
  assert.deepEqual(codexArgs('medium', { resume: 't1' }), [...CODEX_RESUME_ARGS, '-c', 'model_reasoning_effort="medium"', 't1', '-']);
  assert.deepEqual(CODEX_RESUME_ARGS, ['exec', 'resume', '--skip-git-repo-check', '--json']);
  assert.deepEqual(parseClaudeStreamLine('{"type":"system","subtype":"init","session_id":"s-9"}'), { kind: 'session', id: 's-9' });
  assert.deepEqual(parseCodexStreamLine('{"type":"thread.started","thread_id":"t-9"}'), { kind: 'session', id: 't-9' });
  const seenArgs = []; const seenSessions = [];
  const cli = fakeCli(`printf '%s\\n' "$@" | tr '\\n' ' ' >&2; cat >/dev/null; printf '%s\\n' '{"type":"system","subtype":"init","session_id":"forked-1"}' '${claudeLines[6]}'`);
  let current = { resume: 'orig', fork: true };
  const adapter = claudeAdapter(cli, { ...limits, maxBytes: 65536 }, 'inherit', () => ({ ...current, onSession: id => { seenSessions.push(id); current = { resume: id }; } }));
  assert.equal(await adapter('p'), 'Proposal');
  assert.deepEqual(seenSessions, ['forked-1']); assert.deepEqual(current, { resume: 'forked-1' }, 'the next turn resumes the forked session');
  const codexCli = fakeCli(`cat >/dev/null; printf '%s\\n' '{"type":"thread.started","thread_id":"thread-7"}' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`);
  const threads = [];
  assert.equal(await codexAdapter(codexCli, limits, 'inherit', () => ({ resume: 'thread-7', onSession: id => threads.push(id) }))('p'), 'ok');
  assert.deepEqual(threads, ['thread-7']);
  const fresh = [];
  assert.equal(await codexAdapter(codexCli, limits, 'inherit', () => ({ onSession: id => fresh.push(id) }))('p'), 'ok');
  assert.deepEqual(fresh, ['thread-7'], 'without a resume the thread id is still reported so the next turn can resume it');
  assert.deepEqual(codexArgs('inherit', { onSession: () => {} }), [...CODEX_ARGS, '-'], 'no resume flags without a session to resume');
  assert.deepEqual(claudeArgs('inherit', { onSession: () => {} }), CLAUDE_ARGS);
  void seenArgs;
});
test('delta prompts carry only the messages since the agent last spoke', async () => {
  const history = [{ role: 'user', content: 'Task' }, { role: 'claude', content: 'A1' }, { role: 'codex', content: 'C1' }, { role: 'claude', content: 'A2' }, { role: 'user', content: 'Follow-up' }];
  const replay = buildPrompt('id1', 'claude', history, 'replay');
  assert.match(replay, /^You are claude in Turnhuddle conversation id1\. Respond to the user’s latest message/); assert.ok(replay.includes('"A1"'));
  const delta = buildPrompt('id1', 'claude', history, 'delta');
  assert.match(delta, /your earlier turns are in your session/); assert.ok(delta.includes('"Follow-up"')); assert.ok(!delta.includes('"A1"') && !delta.includes('"C1"'));
  const first = buildPrompt('id1', 'claude', [{ role: 'user', content: 'Task' }], 'delta');
  assert.match(first, /continuing from your own earlier session with the user; Codex now joins as a reviewer/); assert.match(first, /Analyse the task/);
  const codexDelta = buildPrompt('id1', 'codex', history.slice(0, 2), 'delta');
  assert.match(codexDelta, /Claude now joins as a reviewer/); assert.ok(codexDelta.includes('"A1"') && codexDelta.includes('"Task"'));
  const prompts = [];
  const adapters = { claude: async p => { prompts.push(['claude', p]); return 'a'; }, codex: async p => { prompts.push(['codex', p]); return 'c'; } };
  await relay({ id: 'x', history: [] }, 'Task', adapters, () => {}, undefined, { context: { claude: 'delta' } });
  assert.match(prompts[0][1], /New messages since your last turn/); assert.match(prompts[1][1], /^You are codex in Turnhuddle conversation x\./, 'codex still gets the replay');
  assert.match(prompts[2][1], /New messages since your last turn:\n\[\{"role":"codex","content":"c"\}\]$/);
});
const { parseVerdict, agreementInstruction, DEFAULT_MAX_TURNS } = require('../dist/bridge');
test('parseVerdict strips a trailing verdict line in its common spellings and ignores verdicts elsewhere', () => {
  assert.deepEqual(parseVerdict('Use a Set.\n\nVERDICT: AGREE'), { body: 'Use a Set.', verdict: 'agree' });
  assert.deepEqual(parseVerdict('Needs a guard.\n**Verdict:** continue\n'), { body: 'Needs a guard.', verdict: 'continue' });
  assert.deepEqual(parseVerdict('Fine.\n`VERDICT: AGREE`'), { body: 'Fine.', verdict: 'agree' }, 'backticks around the verdict are accepted');
  assert.deepEqual(parseVerdict('VERDICT: AGREE is what I would say later.\nMore text.'), { body: 'VERDICT: AGREE is what I would say later.\nMore text.' });
  assert.deepEqual(parseVerdict('Only this.\nverdict: Agree — nothing to add'), { body: 'Only this.', verdict: 'agree' });
  assert.deepEqual(parseVerdict(''), { body: '' }); assert.deepEqual(parseVerdict('   \n'), { body: '   \n' });
  assert.deepEqual(parseVerdict('VERDICT: CONTINUE'), { body: '', verdict: 'continue' }, 'a bare verdict leaves an empty body');
});
test('agreement mode alternates until both agree back to back', async () => {
  const script = { claude: ['Proposal.\nVERDICT: CONTINUE', 'Revised.\nVERDICT: AGREE'], codex: ['Issues.\nVERDICT: CONTINUE', 'Looks final.\nVERDICT: AGREE'] };
  const prompts = []; const turns = [];
  const adapters = { claude: async p => { prompts.push(['claude', p]); return script.claude.shift(); }, codex: async p => { prompts.push(['codex', p]); return script.codex.shift(); } };
  const result = await converse('Task', adapters, () => {}, undefined, { mode: 'agreement', onTurn: (t, r) => turns.push(`${t}:${r}`) });
  assert.deepEqual(result.outcome, { kind: 'agreed', turns: 4 });
  assert.deepEqual(result.history.map(m => [m.role, m.content, m.verdict]), [['user', 'Task', undefined], ['claude', 'Proposal.', 'continue'], ['codex', 'Issues.', 'continue'], ['claude', 'Revised.', 'agree'], ['codex', 'Looks final.', 'agree']]);
  assert.deepEqual(turns, ['1:claude', '2:codex', '3:claude', '4:codex']);
  assert.match(prompts[0][1], /Analyse the task and propose an approach\. End your reply with one final line, exactly `VERDICT: AGREE`/);
  assert.match(prompts[1][1], /Review Claude’s latest response\. If it still needs changes/); assert.match(prompts[2][1], /Review Codex’s latest response/);
  assert.ok(prompts[3][1].includes('"verdict":"agree"'), 'verdicts travel with the replayed history');
});
test('agreement mode: a single AGREE is not enough, a missing verdict counts as continue, and the cap ends the round', async () => {
  const seq = ['A.\nVERDICT: AGREE', 'B.\nVERDICT: CONTINUE', 'C.\nVERDICT: AGREE', 'D.\nVERDICT: AGREE'];
  const adapters = { claude: async () => seq.shift(), codex: async () => seq.shift() };
  const r = await converse('Task', adapters, () => {}, undefined, { mode: 'agreement' });
  assert.deepEqual(r.outcome, { kind: 'agreed', turns: 4 }, 'AGREE, CONTINUE, AGREE, AGREE → agreed on the fourth turn');
  const quick = ['Final.\nVERDICT: AGREE', 'Yes.\nVERDICT: AGREE'];
  const fast = await converse('Task', { claude: async () => quick.shift(), codex: async () => quick.shift() }, () => {}, undefined, { mode: 'agreement' });
  assert.deepEqual(fast.outcome, { kind: 'agreed', turns: 2 }); assert.deepEqual(fast.history.map(m => m.role), ['user', 'claude', 'codex']);
  let n = 0;
  const stubborn = await converse('Task', { claude: async () => `claude ${++n} no verdict`, codex: async () => `codex ${++n}\nVERDICT: AGREE` }, () => {}, undefined, { mode: 'agreement', maxTurns: 5 });
  assert.deepEqual(stubborn.outcome, { kind: 'limit', turns: 5 });
  assert.equal(stubborn.history.filter(m => m.role !== 'user').length, 5);
  assert.equal(stubborn.history[1].verdict, undefined); assert.equal(stubborn.history[2].verdict, 'agree');
  assert.deepEqual((await converse('Task', { claude: async () => 'x\nVERDICT: CONTINUE', codex: async () => 'y\nVERDICT: CONTINUE' }, () => {}, undefined, { mode: 'agreement', maxTurns: 1 })).outcome, { kind: 'limit', turns: 2 }, 'the cap is at least two turns');
  assert.equal(DEFAULT_MAX_TURNS, 10);
});
test('fixed mode is unchanged and reports a fixed outcome', async () => {
  const adapters = { claude: async () => 'Proposal\nVERDICT: AGREE', codex: async () => 'Critique' };
  const r = await converse('Task', adapters, () => {});
  assert.deepEqual(r.outcome, { kind: 'fixed', turns: 3 });
  assert.deepEqual(r.history.map(m => m.role), ['user', 'claude', 'codex', 'claude']);
  assert.equal(r.history[1].content, 'Proposal\nVERDICT: AGREE', 'fixed mode does not parse verdicts'); assert.equal(r.history[1].verdict, undefined);
  assert.match(agreementInstruction('codex', [{ role: 'user', content: 't' }]), /^Analyse the user’s message/);
});
