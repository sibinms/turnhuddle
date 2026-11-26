// Any ACP (Agent Client Protocol, https://agentclientprotocol.com) agent as a live session, as T3 Code drives non-first-party
// agents: initialize, session/new (or session/load), session/prompt per turn, session/update notifications for streamed text and
// tool calls, session/cancel to stop. Permission requests are answered with the agent's own "reject" option: Turnhuddle only
// discusses. Strictly per spec, no agent-specific branches. No VS Code imports.
import type { Progress } from './bridge';
import { deferred, LiveSession, SessionFactory, SessionSpec, TurnOptions } from './live';
import { RpcProcess } from './rpc';
type Update = { sessionUpdate?: string; content?: { type?: string; text?: string }; title?: string; kind?: string };
type PermissionOption = { optionId: string; kind?: string; name?: string };
export const ACP_PROTOCOL_VERSION = 1;
/** Picks the option that refuses: reject_once, then reject_always; cancels when none is offered. */
export function refusePermission(options: PermissionOption[] | undefined): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const reject = options?.find(o => o.kind === 'reject_once') ?? options?.find(o => o.kind === 'reject_always');
  return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
}
export class AcpLiveSession implements LiveSession {
  private readonly rpc: RpcProcess;
  private readonly ready: Promise<void>;
  private id: string | undefined;
  private current: { text: string; onProgress: (p: Progress) => void; done: ReturnType<typeof deferred<string>> } | undefined;
  constructor(readonly provider: string, args: string[], private readonly spec: SessionSpec, private readonly name = provider) {
    const rpc = new RpcProcess(spec.executable, [...args, ...(spec.model ? ['--model', spec.model] : [])], {
      jsonrpc: true, cwd: spec.cwd,
      onNotification: (method, params) => { if (method === 'session/update') this.onUpdate(params as { sessionId?: string; update?: Update }); },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') return refusePermission((params as { options?: PermissionOption[] })?.options);
        throw new Error(`Turnhuddle does not offer ${method}`);
      },
      onExit: error => { this.current?.done.reject(error); this.current = undefined; }
    });
    this.rpc = rpc;
    this.ready = (async () => {
      const init = await rpc.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (spec.resume && init?.agentCapabilities?.loadSession) { await rpc.request('session/load', { sessionId: spec.resume, cwd: spec.cwd, mcpServers: [] }); this.id = spec.resume; }
      else this.id = (await rpc.request<{ sessionId: string }>('session/new', { cwd: spec.cwd, mcpServers: [] })).sessionId;
      spec.onSession?.(this.id);
    })();
    this.ready.catch(() => undefined);
  }
  get sessionId(): string | undefined { return this.id; }
  get busy(): boolean { return !!this.current; }
  async turn(prompt: string, onProgress: (progress: Progress) => void, _options: TurnOptions): Promise<string> {
    await this.ready;
    if (this.current) throw new Error(`${this.name} is still answering the previous message.`);
    const current = { text: '', onProgress, done: deferred<string>() };
    this.current = current;
    this.rpc.request<{ stopReason?: string }>('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text: prompt }] }).then(result => {
      if (this.current === current) this.current = undefined;
      if (result?.stopReason === 'cancelled') current.done.reject(new Error('Conversation cancelled.'));
      else if (current.text.trim()) current.done.resolve(current.text);
      else current.done.reject(new Error(`${this.name} returned no answer${result?.stopReason ? ` (${result.stopReason})` : ''}.`));
    }, error => { if (this.current === current) this.current = undefined; current.done.reject(error instanceof Error ? error : new Error(String(error))); });
    return current.done.promise;
  }
  /** ACP has no steering: the message waits for the next turn. */
  async steer(): Promise<boolean> { return false; }
  async interrupt(): Promise<void> { if (this.current && this.id) this.rpc.notify('session/cancel', { sessionId: this.id }); }
  close(): void { this.rpc.close(); }
  private onUpdate(params: { sessionId?: string; update?: Update }): void {
    const current = this.current; const update = params?.update;
    if (!current || !update || (params.sessionId && params.sessionId !== this.id)) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') { current.text += update.content.text; current.onProgress({ type: 'delta', text: update.content.text }); }
    else if (update.sessionUpdate === 'agent_thought_chunk') current.onProgress({ type: 'activity', text: 'Thinking' });
    else if (update.sessionUpdate === 'tool_call') current.onProgress({ type: 'activity', text: update.title ? `Using ${update.title}`.slice(0, 90) : 'Using a tool' });
  }
}
/** Gemini CLI speaks ACP with `--experimental-acp`. */
export function geminiSessions(): SessionFactory { return spec => new AcpLiveSession('gemini', ['--experimental-acp'], spec, 'Gemini'); }
