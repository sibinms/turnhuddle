const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listClaudeSessions, listCodexSessions, listVendorSessions, summariseClaudeTranscript, summariseCodexRollout, claudeProjectDirName, clip } = require('../dist/vendorSessions');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'turnhuddle-home-'));
const line = o => JSON.stringify(o) + '\n';
const claudeTranscript = ({ id, cwd, prompt, title, sidechainFirst = false }) => [
  line({ type: 'queue-operation', operation: 'enqueue', sessionId: id }),
  sidechainFirst ? line({ type: 'user', isSidechain: true, sessionId: id, cwd, message: { role: 'user', content: 'side task' } }) : '',
  line({ type: 'user', isSidechain: false, sessionId: id, cwd, timestamp: '2026-11-25T10:00:00.000Z', message: { role: 'user', content: prompt } }),
  line({ type: 'assistant', sessionId: id, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] } }),
  line({ type: 'user', sessionId: id, cwd, message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
  title ? line({ type: 'custom-title', customTitle: title, sessionId: id }) : ''
].join('');
const codexRollout = ({ id, cwd, prompt, timestamp = '2026-11-25T09:00:00.000Z' }) => [
  line({ timestamp, type: 'session_meta', payload: { id, cwd, timestamp, cli_version: '0.171' } }),
  line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } }),
  line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
  line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } })
].join('');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
test('claude transcript summary prefers the custom title, else the first human prompt, and skips sidechains and tool results', () => {
  const t = claudeTranscript({ id: 's1', cwd: '/w', prompt: 'Build   a\n dedupe helper', title: 'Dedupe helper design' });
  assert.deepEqual(summariseClaudeTranscript(t, ''), { title: 'Dedupe helper design', cwd: '/w', id: 's1' });
  const noTitle = claudeTranscript({ id: 's2', cwd: '/w', prompt: 'Build   a\n dedupe helper', sidechainFirst: true });
  assert.deepEqual(summariseClaudeTranscript(noTitle, ''), { title: 'Build a dedupe helper', cwd: '/w', id: 's2' });
  assert.equal(summariseClaudeTranscript('', '').title, '(no prompt recorded)');
  const tail = line({ type: 'assistant' }).slice(5) + line({ type: 'custom-title', customTitle: 'Renamed later', sessionId: 's2' });
  assert.equal(summariseClaudeTranscript(noTitle, tail).title, 'Renamed later', 'a title in the tail wins; the partial first tail line is skipped');
});
test('codex rollout summary reads the header and the first real user message', () => {
  const r = codexRollout({ id: 'c1', cwd: '/w', prompt: 'Review the dedupe helper' });
  assert.deepEqual(summariseCodexRollout(r), { title: 'Review the dedupe helper', cwd: '/w', id: 'c1', timestamp: '2026-11-25T09:00:00.000Z' });
  assert.equal(summariseCodexRollout('garbage\n{"type":"x"}').title, '(no prompt recorded)');
});
test('lists sessions newest first, filtered by folder, across both CLIs', async () => {
  const h = home();
  const cwd = '/Users/me/projects/app';
  const dir = path.join(h, '.claude', 'projects', claudeProjectDirName(cwd));
  write(path.join(dir, '11111111-1111-1111-1111-111111111111.jsonl'), claudeTranscript({ id: '11111111-1111-1111-1111-111111111111', cwd, prompt: 'older claude' }));
  write(path.join(dir, '22222222-2222-2222-2222-222222222222.jsonl'), claudeTranscript({ id: '22222222-2222-2222-2222-222222222222', cwd, prompt: 'newer claude', title: 'Newer' }));
  write(path.join(dir, 'notes.txt'), 'ignored');
  write(path.join(h, '.claude', 'projects', '-Users-me-other', '33333333-3333-3333-3333-333333333333.jsonl'), claudeTranscript({ id: '33333333-3333-3333-3333-333333333333', cwd: '/Users/me/other', prompt: 'other folder' }));
  write(path.join(h, '.codex', 'sessions', '2026', '11', '25', 'rollout-2026-11-25T09-00-00-c1.jsonl'), codexRollout({ id: 'c1', cwd, prompt: 'codex here' }));
  write(path.join(h, '.codex', 'sessions', '2026', '11', '24', 'rollout-2026-11-24T09-00-00-c2.jsonl'), codexRollout({ id: 'c2', cwd: '/elsewhere', prompt: 'codex elsewhere' }));
  const now = Date.now();
  fs.utimesSync(path.join(dir, '11111111-1111-1111-1111-111111111111.jsonl'), new Date(now - 3600e3), new Date(now - 3600e3));
  fs.utimesSync(path.join(dir, '22222222-2222-2222-2222-222222222222.jsonl'), new Date(now - 60e3), new Date(now - 60e3));
  const claude = await listClaudeSessions({ home: h, cwd });
  assert.deepEqual(claude.map(s => [s.id, s.title, s.cwd]), [['22222222-2222-2222-2222-222222222222', 'Newer', cwd], ['11111111-1111-1111-1111-111111111111', 'older claude', cwd]]);
  assert.ok(claude[0].file.endsWith('22222222-2222-2222-2222-222222222222.jsonl')); assert.ok(claude[0].bytes > 0); assert.match(claude[0].updatedAt, /^\d{4}-/);
  assert.equal((await listClaudeSessions({ home: h })).length, 3, 'without cwd every project is listed');
  assert.equal((await listClaudeSessions({ home: h, limit: 1 })).length, 1);
  const codex = await listCodexSessions({ home: h, cwd });
  assert.deepEqual(codex.map(s => [s.id, s.title]), [['c1', 'codex here']]);
  assert.equal((await listCodexSessions({ home: h })).length, 2);
  const all = await listVendorSessions({ home: h, cwd });
  assert.deepEqual(new Set(all.map(s => s.provider + ':' + s.id)), new Set(['claude:22222222-2222-2222-2222-222222222222', 'claude:11111111-1111-1111-1111-111111111111', 'codex:c1']));
  assert.deepEqual(all.map(s => s.updatedAt), [...all.map(s => s.updatedAt)].sort().reverse(), 'merged list is newest first');
  assert.equal(all[0].provider, 'codex', 'the rollout written last is newest');
  assert.deepEqual(await listVendorSessions({ home: home(), cwd }), [], 'no CLI folders: empty, no error');
});
test('helpers', () => {
  assert.equal(claudeProjectDirName('/Users/me/projects/app'), '-Users-me-projects-app');
  assert.equal(claudeProjectDirName('/a b.c_d'), '-a-b-c-d');
  assert.equal(clip('  hello   world  '), 'hello world');
  assert.equal(clip('x'.repeat(200)).length, 100); assert.ok(clip('x'.repeat(200)).endsWith('…'));
});
const { folderVariants } = require('../dist/vendorSessions');
test('a folder reached through a symlink matches sessions recorded under its real path', async () => {
  const h = home();
  const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'turnhuddle-real-'));
  const link = path.join(h, 'linked-workspace');
  fs.symlinkSync(real, link);
  assert.deepEqual(await folderVariants(link), [link, real]);
  assert.deepEqual(await folderVariants(real), [real]);
  assert.deepEqual(await folderVariants('/no/such/folder'), ['/no/such/folder']);
  write(path.join(h, '.claude', 'projects', claudeProjectDirName(real), '44444444-4444-4444-4444-444444444444.jsonl'), claudeTranscript({ id: '44444444-4444-4444-4444-444444444444', cwd: real, prompt: 'via real path' }));
  write(path.join(h, '.codex', 'sessions', '2026', '11', '25', 'rollout-2026-11-25T10-00-00-c9.jsonl'), codexRollout({ id: 'c9', cwd: real, prompt: 'codex via real path' }));
  assert.deepEqual((await listClaudeSessions({ home: h, cwd: link })).map(s => s.id), ['44444444-4444-4444-4444-444444444444']);
  assert.deepEqual((await listCodexSessions({ home: h, cwd: link })).map(s => s.id), ['c9']);
});
