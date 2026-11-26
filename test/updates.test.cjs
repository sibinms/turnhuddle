const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { compareVersions, parseRelease, checkDue, evaluate, checkForUpdate, downloadVsix, RELEASES_API, CHECK_INTERVAL_MS, MAX_VSIX_BYTES } = require('../dist/updates');
const vsixBytes = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200, 7)]);
const sha = createHash('sha256').update(vsixBytes).digest('hex');
const releaseJson = (over = {}) => ({
  tag_name: 'v0.3.0', html_url: 'https://github.com/sibinms/turnhuddle/releases/tag/v0.3.0', draft: false, prerelease: false, published_at: '2026-12-01T10:00:00Z',
  assets: [{ name: 'turnhuddle-0.3.0.vsix', browser_download_url: 'https://github.com/sibinms/turnhuddle/releases/download/v0.3.0/turnhuddle-0.3.0.vsix', digest: `sha256:${sha}` }],
  ...over
});
const fakeFetch = (routes) => async (url, init) => {
  const r = routes[url];
  if (!r) throw new Error(`unexpected ${url}`);
  if (r.throws) throw new Error(r.throws);
  assert.equal(init.headers['User-Agent'], 'turnhuddle-vscode', 'requests identify only the extension, nothing about the user');
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, arrayBuffer: async () => r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.length) };
};
test('compareVersions orders x.y.z numerically and ignores suffixes', () => {
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0); assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0); assert.equal(compareVersions('0.2.1-beta', '0.2.1'), 0);
  assert.ok(compareVersions('0.2.0', '0.2.1') < 0);
  assert.ok(compareVersions('nonsense', '0.0.1') < 0); assert.ok(compareVersions('0.0.1', 'nonsense') > 0); assert.equal(compareVersions('x', 'y'), 0);
});
test('parseRelease accepts a published release with its VSIX and digest, and nothing else', () => {
  assert.deepEqual(parseRelease(releaseJson()), { version: '0.3.0', tag: 'v0.3.0', url: 'https://github.com/sibinms/turnhuddle/releases/tag/v0.3.0', vsixUrl: 'https://github.com/sibinms/turnhuddle/releases/download/v0.3.0/turnhuddle-0.3.0.vsix', vsixName: 'turnhuddle-0.3.0.vsix', sha256: sha, publishedAt: '2026-12-01T10:00:00Z' });
  assert.equal(parseRelease(releaseJson({ draft: true })), undefined);
  assert.equal(parseRelease(releaseJson({ prerelease: true })), undefined);
  assert.equal(parseRelease(releaseJson({ assets: [] })), undefined, 'a release without the VSIX is ignored');
  assert.equal(parseRelease(releaseJson({ tag_name: 'latest' })), undefined);
  assert.equal(parseRelease(releaseJson({ assets: [{ name: 'turnhuddle-0.3.0.vsix', browser_download_url: 'https://evil.example/turnhuddle-0.3.0.vsix' }] })), undefined, 'downloads only from this repository');
  assert.equal(parseRelease(releaseJson({ assets: [{ name: 'turnhuddle-0.3.0.vsix', browser_download_url: 'https://github.com/sibinms/turnhuddle/releases/download/v0.3.0/turnhuddle-0.3.0.vsix' }] })).sha256, undefined, 'no digest is allowed');
  assert.equal(parseRelease(null), undefined); assert.equal(parseRelease('x'), undefined);
});
test('checkDue runs once a day and tolerates clock changes', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(checkDue(undefined, now), true);
  assert.equal(checkDue(now - CHECK_INTERVAL_MS + 1000, now), false);
  assert.equal(checkDue(now - CHECK_INTERVAL_MS, now), true);
  assert.equal(checkDue(now + 60000, now), true, 'a last check in the future (clock moved back) allows a new one');
  assert.equal(checkDue(NaN, now), true);
});
test('evaluate and checkForUpdate report available, current, none and error', async () => {
  const release = parseRelease(releaseJson());
  assert.equal(evaluate('0.2.1', release).status, 'available');
  assert.deepEqual(evaluate('0.3.0', release), { status: 'current', current: '0.3.0', latest: '0.3.0' });
  assert.equal(evaluate('0.4.0', release).status, 'current', 'a newer local build is not offered a downgrade');
  assert.deepEqual(evaluate('0.2.1', undefined), { status: 'none', current: '0.2.1' });
  assert.equal((await checkForUpdate('0.2.1', fakeFetch({ [RELEASES_API]: { status: 200, json: releaseJson() } }))).status, 'available');
  assert.deepEqual(await checkForUpdate('0.2.1', fakeFetch({ [RELEASES_API]: { status: 404, json: {} } })), { status: 'none', current: '0.2.1' }, 'no release published yet');
  assert.deepEqual(await checkForUpdate('0.2.1', fakeFetch({ [RELEASES_API]: { status: 403, json: {} } })), { status: 'error', current: '0.2.1', error: 'GitHub answered 403' });
  assert.deepEqual(await checkForUpdate('0.2.1', fakeFetch({ [RELEASES_API]: { throws: 'getaddrinfo ENOTFOUND' } })), { status: 'error', current: '0.2.1', error: 'getaddrinfo ENOTFOUND' });
});
test('downloadVsix checks size, format and checksum', async () => {
  const release = parseRelease(releaseJson());
  const ok = fakeFetch({ [release.vsixUrl]: { status: 200, body: vsixBytes } });
  assert.deepEqual(await downloadVsix(release, ok), vsixBytes);
  const tampered = Buffer.concat([vsixBytes, Buffer.from('x')]);
  await assert.rejects(downloadVsix(release, fakeFetch({ [release.vsixUrl]: { status: 200, body: tampered } })), /checksum does not match/);
  await assert.rejects(downloadVsix(release, fakeFetch({ [release.vsixUrl]: { status: 200, body: Buffer.from('<html>not a zip</html>') } })), /not a VSIX/);
  await assert.rejects(downloadVsix(release, fakeFetch({ [release.vsixUrl]: { status: 200, body: Buffer.alloc(0) } })), /unexpected size/);
  await assert.rejects(downloadVsix(release, fakeFetch({ [release.vsixUrl]: { status: 200, body: Buffer.alloc(MAX_VSIX_BYTES + 1) } })), /unexpected size/);
  await assert.rejects(downloadVsix(release, fakeFetch({ [release.vsixUrl]: { status: 502, body: vsixBytes } })), /GitHub answered 502/);
  const noDigest = { ...release }; delete noDigest.sha256;
  assert.deepEqual(await downloadVsix(noDigest, fakeFetch({ [release.vsixUrl]: { status: 200, body: tampered } })), tampered, 'without a published digest only size and format are checked');
});
