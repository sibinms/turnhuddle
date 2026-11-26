const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locate, bundledBinary, newestExtensionDir, commonDirs, loginShellLookup, defaultExtensionRoots } = require('../dist/cliLocator');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'turnhuddle-cli-'));
const exe = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o755 }); return file; };
test('a configured path other than the default name is used as given', async () => {
  assert.deepEqual(await locate('claude', '/custom/claude', { home: tmp(), platform: 'darwin' }), { path: '/custom/claude', source: 'setting' });
  assert.deepEqual(await locate('codex', ' /x/codex ', { home: tmp(), platform: 'darwin' }), { path: '/x/codex', source: 'setting' });
});
test('the default name is searched on PATH first, then common folders', async () => {
  const home = tmp(); const bin = path.join(home, 'bin');
  exe(path.join(bin, 'claude'));
  exe(path.join(home, '.local', 'bin', 'codex'));
  assert.deepEqual(await locate('claude', 'claude', { home, platform: 'darwin', envPath: `/nope${path.delimiter}${bin}` }), { path: path.join(bin, 'claude'), source: 'path' });
  assert.deepEqual(await locate('codex', undefined, { home, platform: 'darwin', envPath: bin }), { path: path.join(home, '.local', 'bin', 'codex'), source: 'common' });
  fs.writeFileSync(path.join(bin, 'notexec'), 'x', { mode: 0o644 });
  assert.equal(commonDirs(home, 'darwin')[0], path.join(home, '.local', 'bin'));
});
test('the login shell is asked next, and a missing or bad answer is ignored', async () => {
  const home = tmp(); const shellBin = exe(path.join(home, 'shell-only', 'claude'));
  assert.deepEqual(await locate('claude', 'claude', { home, platform: 'darwin', envPath: '', shellLookup: async () => shellBin }), { path: shellBin, source: 'shell' });
  assert.equal(await locate('claude', 'claude', { home, platform: 'darwin', envPath: '', shellLookup: async () => '/does/not/exist' }), undefined);
  assert.equal(await locate('claude', 'claude', { home, platform: 'darwin', envPath: '', shellLookup: async () => { throw new Error('boom'); } }), undefined);
});
test('falls back to the binary bundled in the vendor extension: editor API first, then the newest installed copy', async () => {
  const home = tmp(); const root = path.join(home, '.vscode', 'extensions');
  const older = exe(path.join(root, 'anthropic.claude-code-2.1.9-darwin-arm64', 'resources', 'native-binary', 'claude'));
  const newer = exe(path.join(root, 'anthropic.claude-code-2.1.332-darwin-arm64', 'resources', 'native-binary', 'claude'));
  const codex = exe(path.join(root, 'openai.chatgpt-26.1120.50957-darwin-arm64', 'bin', 'macos-aarch64', 'codex'));
  exe(path.join(root, 'openai.chatgpt-26.1111.1-darwin-arm64', 'bin', 'macos-aarch64', 'codex'));
  assert.equal(newestExtensionDir('claude', [root, path.join(home, 'missing')]), path.dirname(path.dirname(path.dirname(newer))), 'versions compare numerically, not as text');
  const opts = { home, platform: 'darwin', envPath: '', extensionRoots: [root] };
  assert.deepEqual(await locate('claude', 'claude', opts), { path: newer, source: 'extension' });
  assert.deepEqual(await locate('codex', 'codex', opts), { path: codex, source: 'extension' });
  const viaApi = path.join(root, 'anthropic.claude-code-2.1.9-darwin-arm64');
  assert.deepEqual(await locate('claude', 'claude', { ...opts, extensionDirs: { claude: viaApi } }), { path: older, source: 'extension' }, "the running editor's own copy wins");
  assert.equal(bundledBinary('codex', path.join(home, 'nothing'), 'darwin'), undefined);
  assert.equal(await locate('claude', 'claude', { home: tmp(), platform: 'darwin', envPath: '', extensionRoots: [] }), undefined, 'nothing anywhere');
  assert.deepEqual(defaultExtensionRoots('/h').slice(0, 3), ['/h/.vscode/extensions', '/h/.vscode-insiders/extensions', '/h/.cursor/extensions']);
});
test('loginShellLookup asks the shell and rejects odd names', async () => {
  const home = tmp(); const target = exe(path.join(home, 'found', 'mytool'));
  const fakeShell = exe(path.join(home, 'fakeshell'));
  fs.writeFileSync(fakeShell, `#!/bin/sh\necho "shell banner"\necho "${target}"\n`, { mode: 0o755 });
  assert.equal(await loginShellLookup(fakeShell)('mytool'), target, 'takes the last line, ignoring shell start-up output');
  assert.equal(await loginShellLookup(fakeShell)('bad; rm -rf'), undefined);
  assert.equal(await loginShellLookup(path.join(home, 'no-shell'))('mytool'), undefined);
});
const { vendorLogoFiles } = require('../dist/cliLocator');
test('vendorLogoFiles finds the marks shipped inside the vendor extensions', () => {
  const dir = tmp();
  assert.equal(vendorLogoFiles('claude', dir), undefined); assert.equal(vendorLogoFiles('codex', dir), undefined);
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.writeFileSync(path.join(dir, 'resources', 'claude-logo.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'resources', 'blossom-black.svg'), '<svg/>');
  assert.deepEqual(vendorLogoFiles('claude', dir), { light: path.join(dir, 'resources', 'claude-logo.svg'), dark: path.join(dir, 'resources', 'claude-logo.svg') });
  assert.equal(vendorLogoFiles('codex', dir), undefined, 'needs both the light and dark blossom');
  fs.writeFileSync(path.join(dir, 'resources', 'blossom-white.svg'), '<svg/>');
  assert.deepEqual(vendorLogoFiles('codex', dir), { light: path.join(dir, 'resources', 'blossom-black.svg'), dark: path.join(dir, 'resources', 'blossom-white.svg') });
});
