// Lists the Claude Code and Codex CLIs' own saved sessions so a Turnhuddle conversation can continue from one.
// Read-only, best effort: the transcript formats are undocumented and may change with CLI updates. No VS Code imports.
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
export type Provider = 'claude' | 'codex';
export interface VendorSession { provider: Provider; id: string; title: string; cwd: string; updatedAt: string; file: string; bytes: number }
export interface ListOptions { home: string; cwd?: string; limit?: number; now?: number }
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_CHARS = 100;
export function clip(text: string, max = TITLE_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
/** Claude Code keeps one folder per working directory, named from the path with every non-alphanumeric character replaced by "-". */
export function claudeProjectDirName(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
async function readHeadAndTail(file: string): Promise<{ head: string; tail: string; bytes: number }> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const headLength = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    let tail = '';
    if (size > headLength) {
      const tailLength = Math.min(size - headLength, TAIL_BYTES);
      const buffer = Buffer.alloc(tailLength);
      await handle.read(buffer, 0, tailLength, size - tailLength);
      tail = buffer.toString('utf8');
    }
    return { head: head.toString('utf8'), tail, bytes: size };
  } finally { await handle.close(); }
}
function* jsonLines(text: string, skipFirstPartial = false): Generator<Record<string, unknown>> {
  const lines = text.split('\n');
  for (let i = skipFirstPartial ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); if (value && typeof value === 'object') yield value as Record<string, unknown>; } catch { /* partial or foreign line */ }
  }
}
/** Title and folder from a Claude Code transcript: the last custom title if any, else the first human prompt. */
export function summariseClaudeTranscript(head: string, tail: string): { title: string; cwd: string; id?: string } {
  let title = ''; let prompt = ''; let cwd = ''; let id: string | undefined;
  const consider = (e: Record<string, unknown>) => {
    if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) title = e.customTitle;
    if (typeof e.sessionId === 'string' && !id) id = e.sessionId;
    if (typeof e.cwd === 'string' && !cwd) cwd = e.cwd;
    const message = e.message as { role?: unknown; content?: unknown } | undefined;
    if (!prompt && e.type === 'user' && message?.role === 'user' && !e.isSidechain) {
      if (typeof message.content === 'string') prompt = message.content;
      else if (Array.isArray(message.content)) { const text = message.content.find((c: { type?: unknown; text?: unknown }) => c?.type === 'text' && typeof c.text === 'string') as { text: string } | undefined; if (text) prompt = text.text; }
    }
  };
  for (const e of jsonLines(head)) consider(e);
  for (const e of jsonLines(tail, true)) consider(e);
  return { title: clip(title || prompt) || '(no prompt recorded)', cwd, id };
}
/** Title and folder from a Codex rollout: the session header, then the first user message. */
export function summariseCodexRollout(head: string): { title: string; cwd: string; id?: string; timestamp?: string } {
  let title = ''; let cwd = ''; let id: string | undefined; let timestamp: string | undefined;
  for (const e of jsonLines(head)) {
    const payload = e.payload as Record<string, unknown> | undefined;
    if (e.type === 'session_meta' && payload) { if (typeof payload.id === 'string') id = payload.id; if (typeof payload.cwd === 'string') cwd = payload.cwd; if (typeof payload.timestamp === 'string') timestamp = payload.timestamp; }
    if (!title && e.type === 'response_item' && payload?.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
      const text = (payload.content as { type?: unknown; text?: unknown }[]).find(c => (c?.type === 'input_text' || c?.type === 'text') && typeof c.text === 'string') as { text: string } | undefined;
      if (text && !/^<environment_context>|^# AGENTS|^<user_instructions>/.test(text.text.trim())) title = text.text;
    }
    if (!title && e.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') title = payload.message;
  }
  return { title: clip(title) || '(no prompt recorded)', cwd, id, timestamp };
}
/** The folder as given and as resolved (macOS keeps /var under /private/var; the CLIs record the resolved path). */
export async function folderVariants(cwd: string): Promise<string[]> {
  const variants = [cwd];
  try { const real = await realpath(cwd); if (real !== cwd) variants.push(real); } catch { /* keep the given path */ }
  return variants;
}
async function newestFiles(dir: string, pattern: RegExp, recursive: boolean): Promise<{ file: string; mtime: number }[]> {
  const found: { file: string; mtime: number }[] = [];
  const walk = async (current: string, depth: number) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (recursive && depth < 4) await walk(path, depth + 1); continue; }
      if (!pattern.test(entry.name)) continue;
      try { found.push({ file: path, mtime: (await stat(path)).mtimeMs }); } catch { /* vanished */ }
    }
  };
  await walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}
/** Claude Code sessions: `~/.claude/projects/<encoded cwd>/<session>.jsonl`. With `cwd`, only that folder's project; without, every project. */
export async function listClaudeSessions(options: ListOptions): Promise<VendorSession[]> {
  const root = join(options.home, '.claude', 'projects');
  const dirs = options.cwd ? (await folderVariants(options.cwd)).map(cwd => join(root, claudeProjectDirName(cwd))) : await readdir(root).then(names => names.map(n => join(root, n)), () => []);
  const files: { file: string; mtime: number }[] = [];
  for (const dir of dirs) files.push(...await newestFiles(dir, /^[0-9a-f-]{36}\.jsonl$/, false));
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions: VendorSession[] = [];
  for (const { file, mtime } of files.slice(0, options.limit ?? 40)) {
    try {
      const { head, tail, bytes } = await readHeadAndTail(file);
      const summary = summariseClaudeTranscript(head, tail);
      const id = summary.id ?? file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length);
      sessions.push({ provider: 'claude', id, title: summary.title, cwd: summary.cwd, updatedAt: new Date(mtime).toISOString(), file, bytes });
    } catch { /* unreadable */ }
  }
  return sessions;
}
/** Codex sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. With `cwd`, only rollouts recorded in that folder. */
export async function listCodexSessions(options: ListOptions): Promise<VendorSession[]> {
  const root = join(options.home, '.codex', 'sessions');
  const files = await newestFiles(root, /^rollout-.*\.jsonl$/, true);
  const sessions: VendorSession[] = [];
  const limit = options.limit ?? 40;
  const folders = options.cwd ? new Set(await folderVariants(options.cwd)) : undefined;
  for (const { file, mtime } of files) {
    if (sessions.length >= limit) break;
    try {
      const { head, bytes } = await readHeadAndTail(file);
      const summary = summariseCodexRollout(head);
      if (!summary.id) continue;
      if (folders && summary.cwd && !folders.has(summary.cwd)) continue;
      sessions.push({ provider: 'codex', id: summary.id, title: summary.title, cwd: summary.cwd, updatedAt: new Date(mtime).toISOString(), file, bytes });
    } catch { /* unreadable */ }
  }
  return sessions;
}
export async function listVendorSessions(options: ListOptions): Promise<VendorSession[]> {
  const [claude, codex] = await Promise.all([listClaudeSessions(options), listCodexSessions(options)]);
  return [...claude, ...codex].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
