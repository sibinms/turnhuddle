const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROVIDERS, PROVIDER_IDS, parseAgentSetting, formatAgentSetting, agentName, seatNames, sameAgent, parseGeminiStreamLine, geminiArgs, agentAdapter, geminiAdapter, DEFAULT_SEATS } = require('../dist/providers');
const { converse } = require('../dist/bridge');
const { claudeModelLabel, claudeModels, codexModels, geminiModels, discoverModels } = require('../dist/models');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'turnhuddle-providers-'));
const limits = { cwd: process.cwd(), timeoutMs: 5000, maxBytes: 65536 };
const fakeCli = (lines) => {
  const file = path.join(tmp(), 'fake-cli.sh');
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\ncat > "$(dirname "$0")/stdin"\n${lines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`).join('\n')}\n`, { mode: 0o755 });
  return file;
};

test('the registry lists Claude, Codex and Gemini, with Gemini marked preview', () => {
  assert.deepEqual(PROVIDER_IDS, ['claude', 'codex', 'gemini']);
  for (const id of PROVIDER_IDS) { const p = PROVIDERS[id]; assert.equal(p.id, id); assert.ok(p.name && p.product && p.initials && /^#[0-9a-f]{6}$/i.test(p.color) && p.cli && p.installUrl.startsWith('https://')); }
  assert.equal(PROVIDERS.gemini.preview, true); assert.ok(!PROVIDERS.claude.preview && !PROVIDERS.codex.preview);
  assert.deepEqual(DEFAULT_SEATS, { drafter: { provider: 'claude' }, reviewer: { provider: 'codex' } });
});
test('seat settings read as provider or provider:model, and unknown providers fall back', () => {
  const fallback = { provider: 'codex' };
  assert.deepEqual(parseAgentSetting('claude', fallback), { provider: 'claude' });
  assert.deepEqual(parseAgentSetting(' Gemini:gemini-2.5-pro ', fallback), { provider: 'gemini', model: 'gemini-2.5-pro' });
  assert.deepEqual(parseAgentSetting('codex:org/model:v2', fallback), { provider: 'codex', model: 'org/model:v2' }, 'colons after the first stay in the model');
  assert.equal(parseAgentSetting('llama:3', fallback), fallback); assert.equal(parseAgentSetting('', fallback), fallback); assert.equal(parseAgentSetting(7, fallback), fallback);
  assert.equal(formatAgentSetting({ provider: 'claude', model: 'opus', label: 'Opus' }), 'claude:opus'); assert.equal(formatAgentSetting({ provider: 'codex' }), 'codex');
});
test('agent names show the model, and identical seats are told apart', () => {
  assert.equal(agentName({ provider: 'claude' }), 'Claude');
  assert.equal(agentName({ provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' }), 'Claude · Opus 5.5');
  assert.equal(agentName({ provider: 'gemini', model: 'gemini-2.5-pro' }), 'Gemini · gemini-2.5-pro');
  assert.deepEqual(seatNames({ drafter: { provider: 'claude', model: 'opus', label: 'Opus' }, reviewer: { provider: 'claude', model: 'haiku', label: 'Haiku' } }), { drafter: 'Claude · Opus', reviewer: 'Claude · Haiku' });
  assert.deepEqual(seatNames({ drafter: { provider: 'codex' }, reviewer: { provider: 'codex' } }), { drafter: 'Codex (drafter)', reviewer: 'Codex (reviewer)' });
  assert.ok(sameAgent({ provider: 'codex', model: 'm', label: 'M' }, { provider: 'codex', model: 'm' })); assert.ok(!sameAgent({ provider: 'codex' }, { provider: 'codex', model: 'm' }));
});
test('each provider passes the model, effort and session flags its CLI expects', () => {
  assert.deepEqual(PROVIDERS.claude.args({ model: 'opus', effort: 'high' }).slice(0, 3), ['-p', '--model', 'opus']);
  assert.ok(PROVIDERS.claude.args({ model: 'opus', effort: 'high' }).join(' ').includes('--effort high'));
  assert.ok(PROVIDERS.claude.args({ session: { resume: 's1', fork: true } }).join(' ').endsWith('--resume s1 --fork-session'));
  assert.deepEqual(PROVIDERS.codex.args({ model: 'gpt-6.2-sol' }).slice(0, 3), ['exec', '--model', 'gpt-6.2-sol']);
  assert.deepEqual(PROVIDERS.codex.args({ model: 'gpt-6.2-sol', session: { resume: 't1' } }).slice(0, 4), ['exec', 'resume', '--model', 'gpt-6.2-sol']);
  assert.deepEqual(PROVIDERS.codex.args({ effort: 'inherit' }).includes('--model'), false, 'no model flag without a model');
  assert.deepEqual(geminiArgs(), ['--output-format', 'stream-json']);
  assert.deepEqual(PROVIDERS.gemini.args({ model: 'gemini-2.5-flash', effort: 'high' }), ['--output-format', 'stream-json', '--model', 'gemini-2.5-flash'], 'Gemini has no effort flag');
});
test('Gemini stream-json lines become session, text, activity and errors', () => {
  assert.deepEqual(parseGeminiStreamLine('{"type":"init","session_id":"g-1","model":"gemini-2.5-pro"}'), { kind: 'session', id: 'g-1' });
  assert.deepEqual(parseGeminiStreamLine('{"type":"message","role":"assistant","content":"Hel","delta":true}'), { kind: 'delta', text: 'Hel' });
  assert.deepEqual(parseGeminiStreamLine('{"type":"message","role":"assistant","content":"Whole"}'), { kind: 'message', text: 'Whole' });
  assert.equal(parseGeminiStreamLine('{"type":"message","role":"user","content":"prompt"}'), undefined, 'the echoed prompt is not part of the answer');
  assert.deepEqual(parseGeminiStreamLine('{"type":"tool_use","tool_name":"read_file"}'), { kind: 'activity', text: 'Using read_file' });
  assert.match(parseGeminiStreamLine('{"type":"result","status":"error","error":{"message":"quota exceeded"}}').message, /Gemini reported an error: quota exceeded/);
  assert.equal(parseGeminiStreamLine('{"type":"error","severity":"warning","message":"slow"}'), undefined);
  assert.equal(parseGeminiStreamLine('{"type":"result","status":"success"}'), undefined);
  assert.equal(parseGeminiStreamLine('Loaded cached credentials.'), undefined, 'plain log lines are ignored');
});
test('the Gemini adapter streams an answer from a fake CLI, passing the model and the prompt on stdin', async () => {
  const cli = fakeCli(['Loaded cached credentials.', '{"type":"init","session_id":"g-9"}', '{"type":"message","role":"user","content":"echo"}', '{"type":"tool_use","tool_name":"glob"}', '{"type":"message","role":"assistant","content":"Use a ","delta":true}', '{"type":"message","role":"assistant","content":"Set.","delta":true}', '{"type":"result","status":"success","stats":{}}']);
  const progress = []; const sessions = [];
  const answer = await geminiAdapter(cli, limits, () => ({ onSession: id => sessions.push(id) }), 'gemini-2.5-pro')('the prompt', p => progress.push(p));
  assert.equal(answer, 'Use a Set.');
  assert.deepEqual(progress, [{ type: 'activity', text: 'Using glob' }, { type: 'delta', text: 'Use a ' }, { type: 'delta', text: 'Set.' }]);
  assert.deepEqual(sessions, ['g-9']);
  const dir = path.dirname(cli);
  assert.equal(fs.readFileSync(path.join(dir, 'args'), 'utf8').trim(), '--output-format stream-json --model gemini-2.5-pro');
  assert.equal(fs.readFileSync(path.join(dir, 'stdin'), 'utf8'), 'the prompt');
  await assert.rejects(geminiAdapter(fakeCli(['{"type":"result","status":"error","error":{"message":"Please sign in"}}']), limits)('p'), /Gemini reported an error: Please sign in/);
  await assert.rejects(geminiAdapter(fakeCli(['nothing useful']), limits)('p'), /Gemini returned no answer\. Output began: nothing useful/);
  await assert.rejects(agentAdapter(PROVIDERS.gemini, fakeCli([`{"type":"message","role":"assistant","content":"${'x'.repeat(300)}"}`]), { ...limits, maxBytes: 100 })('p'), /Gemini's reply is 300 bytes/);
});
test('any two agents can be seated, and each message records who wrote it', async () => {
  const seats = { drafter: { provider: 'gemini', model: 'gemini-2.5-pro' }, reviewer: { provider: 'claude', model: 'opus', label: 'Opus' } };
  const prompts = [];
  const result = await converse('Task', { drafter: async p => { prompts.push(p); return 'Draft'; }, reviewer: async p => { prompts.push(p); return 'Review'; } }, () => {}, undefined, { seats, names: seatNames(seats) });
  assert.deepEqual(result.history.map(m => [m.role, m.agent && m.agent.provider]), [['user', undefined], ['drafter', 'gemini'], ['reviewer', 'claude'], ['drafter', 'gemini']]);
  assert.match(prompts[0], /^You are Gemini · gemini-2\.5-pro, the drafter, in Turnhuddle conversation [\w-]+, working with Claude · Opus, the reviewer\./);
  assert.match(prompts[1], /Review Gemini · gemini-2\.5-pro’s latest response/);
  assert.match(prompts[2], /\{"from":"Claude · Opus","content":"Review"\}/);
});

test('Claude model ids read as names', () => {
  assert.equal(claudeModelLabel('claude-opus-5-5'), 'Opus 5.5'); assert.equal(claudeModelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(claudeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5'); assert.equal(claudeModelLabel('custom-model'), 'custom-model');
});
test('Claude models: default, aliases, then models from recent sessions, most used first', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-work'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-work', 'a.jsonl'), ['{"message":{"model":"claude-sonnet-5-5"}}', '{"message":{"model":"claude-opus-5-5"}}', '{"message":{"model":"claude-opus-5-5"}}'].join('\n'));
  const list = await claudeModels(home);
  assert.deepEqual(list.map(m => m.id), ['', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.match(list[0].detail, /Opus 5/); assert.equal(list[4].label, 'Opus 5.5');
  assert.deepEqual((await claudeModels(tmp())).map(m => m.id), ['', 'opus', 'sonnet', 'haiku'], 'a machine without Claude Code still gets the aliases');
});
test('Codex models come from the CLI\u2019s model cache, in its order, without hidden ones', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "old-model"\nmodel_reasoning_effort = "high"\n');
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'b', display_name: 'B', priority: 2, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'hidden', display_name: 'Hidden', priority: 0, visibility: 'hide' },
    { slug: 'a', display_name: 'A', description: 'Fast', priority: 1, visibility: 'list' }
  ] }));
  const list = await codexModels(home);
  assert.deepEqual(list.map(m => [m.id, m.label]), [['', 'Default'], ['a', 'A'], ['b', 'B'], ['old-model', 'old-model']]);
  assert.match(list[0].detail, /old-model/); assert.deepEqual(list[2].efforts, ['low', 'high']); assert.equal(list[1].detail, 'Fast');
  assert.deepEqual((await codexModels(tmp())).map(m => m.id), [''], 'no cache: the CLI default only');
});
test('Gemini models: default, the usual models, and the one in Gemini settings', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.gemini'));
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ model: { name: 'gemini-exp-1' } }));
  const ids = (await geminiModels(home)).map(m => m.id);
  assert.equal(ids[0], ''); assert.ok(ids.includes('gemini-2.5-pro') && ids.includes('gemini-2.5-flash')); assert.equal(ids[ids.length - 1], 'gemini-exp-1');
  assert.ok((await discoverModels('gemini', tmp())).length >= 1);
});
