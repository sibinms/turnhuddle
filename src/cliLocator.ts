// Finds the Claude Code and Codex CLIs when the settings are left at their defaults. No VS Code imports.
// Many people only have the copies bundled inside the Claude Code and Codex VS Code extensions, which are not on PATH,
// and VS Code started from the Dock does not see the login shell's PATH either.
import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
export type Agent = 'claude' | 'codex';
export type Source = 'setting' | 'path' | 'common' | 'shell' | 'extension';
export interface Located { path: string; source: Source }
export interface LocateOptions {
  home: string;
  platform: NodeJS.Platform;
  /** PATH of the extension host. */
  envPath?: string;
  /** Install folders of the vendor extensions in this editor, from vscode.extensions. */
  extensionDirs?: Partial<Record<Agent, string>>;
  /** Folders holding installed VS Code-family extensions, searched when the editor API has no answer (e.g. ~/.vscode/extensions). */
  extensionRoots?: string[];
  /** Looks a name up in the login shell; injectable for tests. */
  shellLookup?: (name: string) => Promise<string | undefined>;
}
const EXTENSION_IDS: Record<Agent, string> = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };
export const DEFAULT_NAMES: Record<Agent, string> = { claude: 'claude', codex: 'codex' };
export const SOURCE_LABELS: Record<Source, string> = { setting: 'from settings', path: 'on PATH', common: 'installed', shell: 'from your shell PATH', extension: 'bundled with the VS Code extension' };

export function isExecutable(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}
const exeName = (agent: Agent, platform: NodeJS.Platform) => platform === 'win32' ? `${DEFAULT_NAMES[agent]}.exe` : DEFAULT_NAMES[agent];
/** The binary inside a vendor extension's install folder, if it ships one. */
export function bundledBinary(agent: Agent, extensionDir: string, platform: NodeJS.Platform): string | undefined {
  const name = exeName(agent, platform);
  if (agent === 'claude') {
    const p = join(extensionDir, 'resources', 'native-binary', name);
    return isExecutable(p, platform) ? p : undefined;
  }
  let platforms: string[];
  try { platforms = readdirSync(join(extensionDir, 'bin')); } catch { return undefined; }
  for (const dir of platforms) { const p = join(extensionDir, 'bin', dir, name); if (isExecutable(p, platform)) return p; }
  return undefined;
}
/** Newest installed copy of a vendor extension under the given roots, by version in the folder name. */
export function newestExtensionDir(agent: Agent, roots: string[]): string | undefined {
  const prefix = `${EXTENSION_IDS[agent]}-`;
  const found: { dir: string; version: number[] }[] = [];
  for (const root of roots) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(name.slice(prefix.length));
      if (m) found.push({ dir: join(root, name), version: [Number(m[1]), Number(m[2]), Number(m[3])] });
    }
  }
  found.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return found[0]?.dir;
}
export function commonDirs(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [join(home, 'AppData', 'Roaming', 'npm'), join(home, '.local', 'bin')];
  return [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), '/usr/bin'];
}
/** Resolves the executable to run. A configured value other than the plain default name is always used as given. */
export async function locate(agent: Agent, configured: string | undefined, options: LocateOptions): Promise<Located | undefined> {
  const name = exeName(agent, options.platform);
  const setting = (configured ?? '').trim();
  if (setting && setting !== DEFAULT_NAMES[agent] && setting !== name) return { path: setting, source: 'setting' };
  for (const dir of (options.envPath ?? '').split(delimiter).filter(Boolean)) { const p = join(dir, name); if (isExecutable(p, options.platform)) return { path: p, source: 'path' }; }
  for (const dir of commonDirs(options.home, options.platform)) { const p = join(dir, name); if (isExecutable(p, options.platform)) return { path: p, source: 'common' }; }
  if (options.shellLookup) { const p = await options.shellLookup(name).catch(() => undefined); if (p && isExecutable(p, options.platform)) return { path: p, source: 'shell' }; }
  const fromApi = options.extensionDirs?.[agent];
  const dirs = [fromApi, newestExtensionDir(agent, options.extensionRoots ?? [])].filter((d): d is string => !!d);
  for (const dir of dirs) { const p = bundledBinary(agent, dir, options.platform); if (p) return { path: p, source: 'extension' }; }
  return undefined;
}
/** Asks the user's login shell where a command is (macOS and Linux). Resolves undefined on any failure or after the timeout. */
export function loginShellLookup(shell = process.env.SHELL || '/bin/zsh', timeoutMs = 4000): (name: string) => Promise<string | undefined> {
  return name => new Promise(resolve => {
    if (!/^[a-z.-]+$/i.test(name)) { resolve(undefined); return; }
    execFile(shell, ['-lc', `command -v ${name}`], { timeout: timeoutMs }, (error, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').pop() ?? '';
      resolve(!error && line.startsWith('/') ? line : undefined);
    });
  });
}
/** Folders where VS Code-family editors keep extensions. */
export function defaultExtensionRoots(home: string): string[] {
  return ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss'].map(d => join(home, d, 'extensions'));
}

/** Logo files shipped inside the vendor's own VS Code extension: [for light themes, for dark themes]. Undefined when absent. */
export function vendorLogoFiles(agent: Agent, extensionDir: string): { light: string; dark: string } | undefined {
  const pick = (...names: string[]) => names.map(n => join(extensionDir, 'resources', n)).find(p => { try { return statSync(p).isFile(); } catch { return false; } });
  if (agent === 'claude') { const logo = pick('claude-logo.svg', 'claude-logo.png'); return logo ? { light: logo, dark: logo } : undefined; }
  const light = pick('blossom-black.svg'); const dark = pick('blossom-white.svg');
  return light && dark ? { light, dark } : undefined;
}
