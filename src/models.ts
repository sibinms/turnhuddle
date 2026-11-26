// Models each provider offers on this machine, read from the CLIs' own local files. Read-only and best effort. No VS Code imports.
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from './providers';
export interface ModelChoice {
  /** Value passed to the CLI's --model flag. Empty for "the CLI's own default". */
  id: string;
  label: string;
  detail?: string;
  /** Reasoning levels the model accepts, when the CLI says. */
  efforts?: string[];
}
const TAIL_BYTES = 64 * 1024;
const RECENT_FILES = 30;
/** "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5". Unrecognised ids are returned unchanged. */
export function claudeModelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
async function readTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try { const v = JSON.parse(await readFile(file, 'utf8')); return v && typeof v === 'object' ? v as Record<string, unknown> : undefined; } catch { return undefined; }
}
/** Newest `.jsonl` transcripts under `dir`'s sub-folders. */
async function recentTranscripts(dir: string, limit = RECENT_FILES): Promise<string[]> {
  const files: { file: string; mtime: number }[] = [];
  let folders: string[];
  try { folders = await readdir(dir); } catch { return []; }
  for (const folder of folders) {
    let names: string[];
    try { names = await readdir(join(dir, folder)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try { const file = join(dir, folder, name); files.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(f => f.file);
}
/** Claude: the configured model, the aliases the CLI accepts, and the models seen in recent Claude Code sessions. */
export async function claudeModels(home: string): Promise<ModelChoice[]> {
  const settings = await readJson(join(home, '.claude', 'settings.json'));
  const configured = typeof settings?.model === 'string' ? settings.model : undefined;
  const seen = new Map<string, number>();
  for (const file of await recentTranscripts(join(home, '.claude', 'projects'))) {
    try { for (const m of (await readTail(file)).matchAll(/"model":"(claude-[a-z0-9-]+)"/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1); } catch { /* unreadable */ }
  }
  const out: ModelChoice[] = [
    { id: '', label: 'Default', detail: configured ? `Your Claude Code setting (${claudeModelLabel(configured)})` : 'Your Claude Code setting' },
    { id: 'opus', label: 'Opus', detail: 'Latest Opus' }, { id: 'sonnet', label: 'Sonnet', detail: 'Latest Sonnet' }, { id: 'haiku', label: 'Haiku', detail: 'Latest Haiku' }
  ];
  for (const id of [...seen.keys()].sort((a, b) => (seen.get(b) ?? 0) - (seen.get(a) ?? 0))) out.push({ id, label: claudeModelLabel(id), detail: `${id} · used in recent sessions` });
  return out;
}
/** Codex: the model list the Codex CLI caches for your account (~/.codex/models_cache.json), in its own order. */
export async function codexModels(home: string): Promise<ModelChoice[]> {
  let configured: string | undefined;
  try { configured = /^\s*model\s*=\s*"([^"]+)"/m.exec(await readFile(join(home, '.codex', 'config.toml'), 'utf8'))?.[1]; } catch { /* no config */ }
  const cache = await readJson(join(home, '.codex', 'models_cache.json'));
  const listed = (Array.isArray(cache?.models) ? cache.models : []) as Record<string, unknown>[];
  const out: ModelChoice[] = [{ id: '', label: 'Default', detail: configured ? `Your Codex setting (${configured})` : 'Your Codex setting' }];
  const models = listed.filter(m => typeof m.slug === 'string' && m.visibility !== 'hide').sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99));
  for (const m of models) {
    const efforts = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]).map(l => l.effort).filter((e): e is string => typeof e === 'string') : undefined;
    out.push({ id: m.slug as string, label: typeof m.display_name === 'string' ? m.display_name : m.slug as string, ...(typeof m.description === 'string' ? { detail: m.description } : {}), ...(efforts?.length ? { efforts } : {}) });
  }
  if (configured && !out.some(m => m.id === configured)) out.push({ id: configured, label: configured, detail: 'From ~/.codex/config.toml' });
  return out;
}
/** Gemini: the CLI's default, the model in ~/.gemini/settings.json, and the commonly available Gemini models. */
export async function geminiModels(home: string): Promise<ModelChoice[]> {
  const settings = await readJson(join(home, '.gemini', 'settings.json'));
  const model = settings?.model as { name?: unknown } | string | undefined;
  const configured = typeof model === 'string' ? model : typeof model?.name === 'string' ? model.name : undefined;
  const out: ModelChoice[] = [{ id: '', label: 'Default', detail: configured ? `Your Gemini CLI setting (${configured})` : 'The Gemini CLI’s default' }];
  for (const [id, detail] of [['gemini-2.5-pro', 'Most capable'], ['gemini-2.5-flash', 'Fast'], ['gemini-2.5-flash-lite', 'Fastest']]) out.push({ id, label: id, detail });
  if (configured && !out.some(m => m.id === configured)) out.push({ id: configured, label: configured, detail: 'From ~/.gemini/settings.json' });
  return out;
}
export const MODEL_SOURCES: Record<ProviderId, (home: string) => Promise<ModelChoice[]>> = { claude: claudeModels, codex: codexModels, gemini: geminiModels };
export async function discoverModels(id: ProviderId, home: string): Promise<ModelChoice[]> {
  try { return await MODEL_SOURCES[id](home); } catch { return [{ id: '', label: 'Default' }]; }
}
