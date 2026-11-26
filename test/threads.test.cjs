const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supportsSecondarySidebar, threadState, threadRow, threadGroups, shortAge } = require('../dist/threads');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
const conv = (id, extra = {}) => ({ id, task: `Task ${id}`, cwd: '/w', createdAt: ago(100), updatedAt: ago(10), archived: false, status: 'completed', messages: [{ role: 'user', content: 't', receivedAt: ago(10) }], ...extra });

test('the chat moves to the secondary side bar from VS Code 1.106, like Claude Code', () => {
  assert.equal(supportsSecondarySidebar('1.146.0'), true); assert.equal(supportsSecondarySidebar('1.106.0'), true); assert.equal(supportsSecondarySidebar('2.0.0'), true);
  assert.equal(supportsSecondarySidebar('1.105.9'), false); assert.equal(supportsSecondarySidebar('1.95.0-insider'), false); assert.equal(supportsSecondarySidebar('garbage'), false);
});
test('thread state and badges follow the outcome', () => {
  assert.equal(threadState(conv('a', { outcome: { kind: 'agreed', turns: 4 } }), false), 'agreed');
  assert.equal(threadState(conv('a', { outcome: { kind: 'limit', turns: 10 } }), false), 'no-agreement');
  assert.equal(threadState(conv('a'), false), 'done'); assert.equal(threadState(conv('a', { status: 'failed' }), false), 'failed');
  assert.equal(threadState(conv('a', { status: 'cancelled' }), false), 'stopped'); assert.equal(threadState(conv('a'), true), 'running');
});
test('rows: title, state and age, a tooltip with the agents, and menus keyed by state', () => {
  const row = threadRow(conv('a', { title: 'Rate limit login', outcome: { kind: 'agreed', turns: 4 }, seats: { drafter: { provider: 'claude', model: 'opus', label: 'Opus' }, reviewer: { provider: 'codex' } } }), false, NOW);
  assert.deepEqual([row.label, row.description, row.icon, row.contextValue], ['Rate limit login', 'Agreed · 10m', 'pass', 'thread-live']);
  assert.match(row.tooltip, /Agreed · 1 round\nClaude · Opus ⇄ Codex\n\/w$/);
  const busy = threadRow(conv('b', { bookmarked: true }), true, NOW);
  assert.deepEqual([busy.description, busy.icon, busy.contextValue], ['10m', 'loading~spin', 'thread-live bookmarked running']);
  assert.equal(threadRow(conv('c', { bookmarked: true }), false, NOW).icon, 'bookmark');
  assert.equal(threadRow(conv('d', { archived: true }), false, NOW).contextValue, 'thread-archived');
  assert.equal(threadRow(conv('e', { task: '' }), false, NOW).label, 'Untitled');
});
test('groups: bookmarked, then recent with running threads first; archived only when shown', () => {
  const list = [conv('old', { updatedAt: ago(300) }), conv('new', { updatedAt: ago(1) }), conv('run', { updatedAt: ago(500) }), conv('mark', { bookmarked: true }), conv('gone', { archived: true })];
  const running = id => id === 'run';
  assert.deepEqual(threadGroups(list, running).map(g => [g.id, g.threads.map(c => c.id)]), [['bookmarked', ['mark']], ['active', ['run', 'new', 'old']]]);
  assert.deepEqual(threadGroups(list, running, true).map(g => g.id), ['bookmarked', 'active', 'archived']);
  assert.deepEqual(threadGroups([], running), []);
});
test('short ages', () => {
  assert.equal(shortAge(ago(0), NOW), 'now'); assert.equal(shortAge(ago(42), NOW), '42m'); assert.equal(shortAge(ago(180), NOW), '3h'); assert.equal(shortAge(ago(60 * 24 * 3), NOW), '3d');
  assert.equal(shortAge('nope', NOW), '');
});
