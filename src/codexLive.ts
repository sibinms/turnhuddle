// Codex as a live session through `codex app-server` (JSON-RPC over stdio), as T3 Code drives it: one thread per Turnhuddle
// thread and seat, turns streamed with item/agentMessage/delta, steered with turn/steer and stopped with turn/interrupt.
// Read-only sandbox and no approval prompts: Turnhuddle's agents discuss, they don't edit. No VS Code imports.
import type { Progress } from './bridge';
import { deferred, LiveSession, SessionFactory, SessionSpec, TurnOptions } from './live';
import { RpcProcess } from './rpc';
type Item = { type?: string; id?: string; text?: string; command?: string; tool?: string; server?: string };
type Turn = { id?: string; status?: string; error?: { message?: string } | null };
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
/** Short note for the chat while Codex works on something other than its reply. */
export function codexActivity(item: Item): string | undefined {
  switch (item.type) {
    case 'reasoning': return 'Reasoning';
    case 'commandExecution': return `Running ${(item.command ?? 'a command').slice(0, 80)}`;
    case 'webSearch': return 'Searching the web';
    case 'mcpToolCall': return `Using ${item.tool ?? 'a tool'}${item.server ? ` (${item.server})` : ''}`;
    case 'fileChange': return 'Proposing a file change';
    case 'plan': return 'Planning';
    default: return undefined;
  }
}
export class CodexLiveSession implements LiveSession {
  readonly provider = 'codex';
  private readonly rpc: RpcProcess;
  private readonly ready: Promise<void>;
  private threadId: string | undefined;
  private current: { id?: string; items: Map<string, string>; order: string[]; error?: string; onProgress: (p: Progress) => void; done: ReturnType<typeof deferred<string>> } | undefined;
  constructor(executable: string, private readonly spec: SessionSpec, extraArgs: string[] = [], version = '0.0.0') {
    const rpc = new RpcProcess(executable, ['app-server', ...extraArgs], {
      cwd: spec.cwd,
      onNotification: (method, params) => this.onNotification(method, params as Record<string, unknown>),
      // Approvals can't arise with approvalPolicy "never", but if Codex asks anyway the answer is no: Turnhuddle only discusses.
      onRequest: method => { if (/requestApproval|Approval$/.test(method)) return { decision: 'decline' }; throw new Error(`Turnhuddle does not handle ${method}`); },
      onExit: error => { this.current?.done.reject(error); this.current = undefined; }
    });
    this.rpc = rpc;
    this.ready = (async () => {
      await rpc.request('initialize', { clientInfo: { name: 'turnhuddle', title: 'Turnhuddle', version }, capabilities: { experimentalApi: false, requestAttestation: false } });
      rpc.notify('initialized');
      const params = { cwd: spec.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(spec.model ? { model: spec.model } : {}) };
      const started = await rpc.request<{ thread: { id: string } }>(spec.resume ? 'thread/resume' : 'thread/start', spec.resume ? { threadId: spec.resume, ...params } : params);
      this.threadId = started.thread.id;
      spec.onSession?.(started.thread.id);
    })();
    this.ready.catch(() => undefined);
  }
  get sessionId(): string | undefined { return this.threadId; }
  get busy(): boolean { return !!this.current; }
  async turn(prompt: string, onProgress: (progress: Progress) => void, options: TurnOptions): Promise<string> {
    await this.ready;
    if (this.current) throw new Error('Codex is still answering the previous message.');
    const current: NonNullable<CodexLiveSession['current']> = { items: new Map<string, string>(), order: [], onProgress, done: deferred<string>() };
    this.current = current;
    try {
      const started = await this.rpc.request<{ turn: Turn }>('turn/start', { threadId: this.threadId, input: text(prompt), ...(options.model ? { model: options.model } : {}), ...(options.effort && options.effort !== 'inherit' ? { effort: options.effort } : {}) });
      current.id ??= started.turn.id;
    } catch (error) { this.current = undefined; throw error; }
    return current.done.promise;
  }
  async steer(message: string): Promise<boolean> {
    const current = this.current;
    if (!current?.id) return false;
    try { await this.rpc.request('turn/steer', { threadId: this.threadId, input: text(message), expectedTurnId: current.id }); return true; } catch { return false; }
  }
  async interrupt(): Promise<void> {
    const current = this.current;
    if (current?.id && this.threadId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: current.id }).catch(() => undefined);
  }
  close(): void { this.rpc.close(); }
  private onNotification(method: string, params: Record<string, unknown>): void {
    const current = this.current;
    if (!current || (params?.threadId && params.threadId !== this.threadId)) return;
    if (method === 'turn/started') current.id ??= (params.turn as Turn | undefined)?.id;
    else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const id = String(params.itemId ?? '');
      if (!current.items.has(id)) { if (current.order.some(k => current.items.get(k))) current.onProgress({ type: 'delta', text: '\n\n' }); current.items.set(id, ''); current.order.push(id); }
      current.items.set(id, (current.items.get(id) ?? '') + params.delta);
      current.onProgress({ type: 'delta', text: params.delta });
    } else if (method === 'item/started') {
      const note = codexActivity((params.item ?? {}) as Item);
      if (note) current.onProgress({ type: 'activity', text: note });
    } else if (method === 'item/completed') {
      const item = (params.item ?? {}) as Item;
      if (item.type === 'agentMessage' && item.id && typeof item.text === 'string') { if (!current.items.has(item.id)) current.order.push(item.id); current.items.set(item.id, item.text); }
    } else if (method === 'error') {
      const error = params.error as { message?: string } | undefined;
      if (!params.willRetry && error?.message) current.error = error.message;
    } else if (method === 'turn/completed') {
      const turn = (params.turn ?? {}) as Turn;
      this.current = undefined;
      const reply = current.order.map(id => current.items.get(id) ?? '').filter(Boolean).join('\n\n');
      if (turn.status === 'completed' && reply.trim()) current.done.resolve(reply);
      else if (turn.status === 'interrupted') current.done.reject(new Error('Conversation cancelled.'));
      else current.done.reject(new Error(`Codex reported an error${turn.error?.message || current.error ? `: ${turn.error?.message ?? current.error}` : ''}.`));
    }
  }
}
export function codexSessions(extraArgs: string[] = [], version?: string): SessionFactory {
  return spec => new CodexLiveSession(spec.executable, spec, extraArgs, version);
}
