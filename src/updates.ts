// Update checks against GitHub Releases. Pure logic plus a small network layer; no VS Code imports.
import { createHash } from 'node:crypto';
export const RELEASES_API = 'https://api.github.com/repos/sibinms/turnhuddle/releases/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Largest VSIX the updater will download. */
export const MAX_VSIX_BYTES = 20 * 1024 * 1024;
export interface Release { version: string; tag: string; url: string; vsixUrl: string; vsixName: string; sha256?: string; publishedAt?: string }
export type UpdateCheck = { status: 'available'; current: string; release: Release } | { status: 'current'; current: string; latest: string } | { status: 'none'; current: string } | { status: 'error'; current: string; error: string };

/** Numeric x.y.z comparison; anything after the patch number (pre-release, build) is ignored. Unparsable input sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined; };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
/** Reads GitHub's "latest release" JSON. Drafts, pre-releases and releases without a turnhuddle-<version>.vsix asset are ignored. */
export function parseRelease(json: unknown): Release | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: unknown };
  if (r.draft || r.prerelease || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return undefined;
  const version = r.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const assets = Array.isArray(r.assets) ? r.assets as { name?: unknown; browser_download_url?: unknown; digest?: unknown }[] : [];
  const vsix = assets.find(a => a.name === `turnhuddle-${version}.vsix` && typeof a.browser_download_url === 'string');
  if (!vsix) return undefined;
  const digest = typeof vsix.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(vsix.digest) ? vsix.digest.slice(7).toLowerCase() : undefined;
  if (!/^https:\/\/github\.com\/sibinms\/turnhuddle\/releases\/download\//.test(vsix.browser_download_url as string)) return undefined;
  return { version, tag: r.tag_name, url: r.html_url, vsixUrl: vsix.browser_download_url as string, vsixName: vsix.name as string, ...(digest ? { sha256: digest } : {}), ...(typeof r.published_at === 'string' ? { publishedAt: r.published_at } : {}) };
}
/** Whether an automatic check is due. */
export function checkDue(lastCheck: number | undefined, now: number, interval = CHECK_INTERVAL_MS): boolean {
  return !lastCheck || !Number.isFinite(lastCheck) || now - lastCheck >= interval || now < lastCheck;
}
/** What to tell the user for a given installed version and latest release. */
export function evaluate(current: string, release: Release | undefined): UpdateCheck {
  if (!release) return { status: 'none', current };
  return compareVersions(release.version, current) > 0 ? { status: 'available', current, release } : { status: 'current', current, latest: release.version };
}
export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
const HEADERS = { 'User-Agent': 'turnhuddle-vscode', Accept: 'application/vnd.github+json' };
/** Asks GitHub for the latest release. A 404 means no release has been published yet. */
export async function checkForUpdate(current: string, fetcher: Fetcher, timeoutMs = 10000): Promise<UpdateCheck> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher(RELEASES_API, { headers: HEADERS, signal });
    if (response.status === 404) return { status: 'none', current };
    if (!response.ok) return { status: 'error', current, error: `GitHub answered ${response.status}` };
    return evaluate(current, parseRelease(await response.json()));
  } catch (error) {
    return { status: 'error', current, error: error instanceof Error ? error.message : String(error) };
  }
}
/** Downloads the release's VSIX and checks its size and, when GitHub publishes one, its SHA-256 digest. */
export async function downloadVsix(release: Release, fetcher: Fetcher, timeoutMs = 120000): Promise<Buffer> {
  const response = await fetcher(release.vsixUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Download failed: GitHub answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_VSIX_BYTES) throw new Error(`Download failed: unexpected size (${data.length} bytes)`);
  if (data.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('Download failed: the file is not a VSIX package');
  if (release.sha256) {
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== release.sha256) throw new Error('Download failed: the checksum does not match the one GitHub published');
  }
  return data;
}
