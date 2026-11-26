// The agents Turnhuddle can seat: one entry per command-line harness. No VS Code imports.
// Adding a provider means adding one entry here (how to call its CLI and read its output) and, optionally, model discovery in models.ts.
import { AgentSpec, Adapter, checkReplySize, claudeArgs, codexArgs, Limits, lineSplitter, parseClaudeStreamLine, parseCodexStreamLine, run, Seat, SessionOptions, SessionProvider, summarize } from './bridge';
export type ProviderId = 'claude' | 'codex' | 'gemini';
/** What one line of a CLI's output means. `delta` is streamed answer text, `message` a complete answer block, `result` the final answer. */
export type AgentEvent = { kind: 'delta'; text: string } | { kind: 'message'; text: string } | { kind: 'result'; text: string } | { kind: 'activity'; text: string } | { kind: 'session'; id: string } | { kind: 'error'; message: string };
export interface CallOptions { model?: string; effort?: string; session?: SessionOptions }
export interface ProviderDef {
  id: ProviderId;
  /** Short name used in the chat ("Claude"). */
  name: string;
  /** The product, for messages about installing or finding it ("Claude Code"). */
  product: string;
  /** Avatar text when no logo is available. */
  initials: string;
  color: string;
  /** Executable name looked up on PATH, and the `turnhuddle.<id>Path` setting's default. */
  cli: string;
  /** Not yet verified against the real CLI by the maintainers. */
  preview?: boolean;
  /** Where to get the CLI. */
  installUrl: string;
  /** Setting that holds this provider's effort, if it has one. */
  effortSetting?: string;
  /** How a CLI session can be continued: `fork` copies it (original untouched), `continue` resumes it in place. */
  resume: 'fork' | 'continue' | false;
  args(options: CallOptions): string[];
  parse(line: string): AgentEvent | undefined;
}
function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}
/** One line of `gemini --output-format stream-json`: init (session), assistant message chunks, tool use, errors and a final result. */
export function parseGeminiStreamLine(line: string): AgentEvent | undefined {
  const event = parseJsonLine(line);
  if (!event) return undefined;
  const type = String(event.type ?? '');
  if (type === 'init' && typeof event.session_id === 'string') return { kind: 'session', id: event.session_id };
  if (type === 'message' && event.role === 'assistant' && typeof event.content === 'string') return event.delta === true ? { kind: 'delta', text: event.content } : { kind: 'message', text: event.content };
  if (type === 'tool_use') return { kind: 'activity', text: `Using ${typeof event.tool_name === 'string' ? event.tool_name : 'a tool'}` };
  const error = event.error as { message?: unknown } | undefined;
  if (type === 'error' && event.severity !== 'warning') return { kind: 'error', message: `Gemini reported an error${typeof event.message === 'string' ? `: ${summarize(event.message)}` : ''}.` };
  if (type === 'result' && event.status === 'error') return { kind: 'error', message: `Gemini reported an error${typeof error?.message === 'string' ? `: ${summarize(error.message)}` : ''}. Check that you are signed in to the Gemini CLI.` };
  return undefined;
}
export function geminiArgs(options: CallOptions = {}): string[] {
  const args = ['--output-format', 'stream-json'];
  if (options.model) args.push('--model', options.model);
  return args;
}
export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  claude: {
    id: 'claude', name: 'Claude', product: 'Claude Code', initials: 'C', color: '#d97757', cli: 'claude', installUrl: 'https://code.claude.com/docs/en/cli-reference',
    effortSetting: 'claudeEffort', resume: 'fork',
    args: o => { const args = claudeArgs((o.effort ?? 'inherit') as Parameters<typeof claudeArgs>[0], o.session); if (o.model) args.splice(1, 0, '--model', o.model); return args; },
    parse: line => { const e = parseClaudeStreamLine(line); return !e ? undefined : e.kind === 'delta' ? e : e.kind === 'result' ? e : e.kind === 'session' ? e : { kind: 'error', message: e.message }; }
  },
  codex: {
    id: 'codex', name: 'Codex', product: 'Codex', initials: 'Cx', color: '#10a37f', cli: 'codex', installUrl: 'https://developers.openai.com/codex/cli',
    effortSetting: 'codexReasoningEffort', resume: 'continue',
    args: o => { const args = codexArgs(o.effort ?? 'inherit', o.session); if (o.model) args.splice(o.session?.resume ? 2 : 1, 0, '--model', o.model); return args; },
    parse: line => parseCodexStreamLine(line)
  },
  gemini: {
    id: 'gemini', name: 'Gemini', product: 'Gemini CLI', initials: 'G', color: '#4f7cf7', cli: 'gemini', preview: true, installUrl: 'https://github.com/google-gemini/gemini-cli',
    resume: false,
    args: o => geminiArgs(o),
    parse: parseGeminiStreamLine
  }
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export function isProviderId(value: unknown): value is ProviderId { return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, value); }
export function provider(id: string): ProviderDef | undefined { return isProviderId(id) ? PROVIDERS[id] : undefined; }
/** The seats a conversation starts with when nothing is configured: the original Claude-drafts, Codex-reviews pairing. */
export const DEFAULT_SEATS: Record<Seat, AgentSpec> = { drafter: { provider: 'claude' }, reviewer: { provider: 'codex' } };
/** Parses a seat setting such as `claude`, `codex:gpt-6.2-sol` or `gemini:gemini-2.5-pro`. Unknown providers fall back to `fallback`. */
export function parseAgentSetting(value: unknown, fallback: AgentSpec): AgentSpec {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const [id, ...rest] = value.trim().split(':');
  if (!isProviderId(id.trim().toLowerCase())) return fallback;
  const model = rest.join(':').trim();
  return { provider: id.trim().toLowerCase(), ...(model ? { model } : {}) };
}
export function formatAgentSetting(spec: AgentSpec): string { return spec.model ? `${spec.provider}:${spec.model}` : spec.provider; }
/** "Claude", or "Claude · Opus 5.5" when a model is chosen. */
export function agentName(spec: AgentSpec | undefined): string {
  if (!spec) return 'Agent';
  const name = provider(spec.provider)?.name ?? spec.provider;
  const model = spec.label ?? spec.model;
  return model ? `${name} · ${model}` : name;
}
/** Display names for both seats; when they would read the same, the seat is added so the two can be told apart. */
export function seatNames(seats: Record<Seat, AgentSpec>): Record<Seat, string> {
  const drafter = agentName(seats.drafter), reviewer = agentName(seats.reviewer);
  return drafter === reviewer ? { drafter: `${drafter} (drafter)`, reviewer: `${reviewer} (reviewer)` } : { drafter, reviewer };
}
export function sameAgent(a: AgentSpec | undefined, b: AgentSpec | undefined): boolean { return !!a && !!b && a.provider === b.provider && (a.model ?? '') === (b.model ?? ''); }
/** Runs one turn through a provider's CLI: streams deltas and activity, reports the session id, and returns the answer. */
export function agentAdapter(def: ProviderDef, executable: string, limits: Limits, call: { model?: string; effort?: string } = {}, session?: SessionProvider): Adapter {
  return async (prompt, onProgress) => {
    const options = session?.();
    const messages: string[] = []; let streamed = ''; let result: string | undefined; let error: string | undefined;
    const lines = lineSplitter(line => {
      const event = def.parse(line);
      if (!event) return;
      if (event.kind === 'delta') { streamed += event.text; onProgress?.({ type: 'delta', text: event.text }); }
      else if (event.kind === 'message') { messages.push(event.text); onProgress?.({ type: 'delta', text: (messages.length > 1 || streamed ? '\n\n' : '') + event.text }); }
      else if (event.kind === 'result') result = event.text;
      else if (event.kind === 'activity') onProgress?.({ type: 'activity', text: event.text });
      else if (event.kind === 'session') options?.onSession?.(event.id);
      else error = event.message;
    });
    const raw = await run(executable, def.args({ ...call, session: options }), prompt, { ...limits, onStdout: chunk => lines.push(chunk) });
    lines.flush();
    const answer = result ?? (messages.length ? messages.join('\n\n') : streamed);
    if (error && !answer.trim()) throw new Error(error);
    if (answer.trim()) return checkReplySize(def.name, answer, limits.maxBytes);
    throw new Error(`${def.name} returned no answer. Output began: ${summarize(raw, 200, 'start') || '(empty)'}`);
  };
}
/** Claude Code adapter (kept for callers and tests that name the provider directly). */
export function claudeAdapter(executable: string, limits: Limits, effort = 'inherit', session?: SessionProvider, model?: string): Adapter { return agentAdapter(PROVIDERS.claude, executable, limits, { effort, model }, session); }
export function codexAdapter(executable: string, limits: Limits, effort = 'inherit', session?: SessionProvider, model?: string): Adapter { return agentAdapter(PROVIDERS.codex, executable, limits, { effort, model }, session); }
export function geminiAdapter(executable: string, limits: Limits, session?: SessionProvider, model?: string): Adapter { return agentAdapter(PROVIDERS.gemini, executable, limits, { model }, session); }
