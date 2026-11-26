// Claude as a live session through the Claude Agent SDK, as T3 Code drives it: one streaming-input query per Turnhuddle thread
// and seat, pointed at the user's own Claude Code CLI. Plan mode, and any tool that would change something is refused:
// Turnhuddle's agents discuss, they don't edit. The SDK is loaded lazily (it is ESM). No VS Code imports.
import type { Progress } from './bridge';
import { deferred, LiveSession, SessionFactory, SessionSpec, TurnOptions } from './live';
/** Tools that only read: allowed without asking. Everything else is refused with a note to the agent. */
export const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
type SdkMessage = { type: string; subtype?: string; session_id?: string; event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } }; message?: { content?: { type?: string; name?: string }[] }; result?: unknown; is_error?: boolean; errors?: string[] };
type UserMessage = { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null; priority?: 'now' | 'next' | 'later' };
type Query = AsyncIterable<SdkMessage> & { interrupt(): Promise<unknown>; setModel(model?: string): Promise<void>; close?(): void };
type QueryFn = (params: { prompt: AsyncIterable<UserMessage>; options: Record<string, unknown> }) => Query;
/** Loads the SDK's ESM entry from CommonJS. A plain `import()` would be compiled to `require()`. */
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ query: QueryFn }>;
let sdk: Promise<{ query: QueryFn }> | undefined;
export function loadSdk(): Promise<{ query: QueryFn }> { sdk ??= importEsm('@anthropic-ai/claude-agent-sdk'); return sdk; }
/** A queue the SDK reads user messages from for as long as the session lives. */
class Inbox implements AsyncIterable<UserMessage> {
  private readonly items: UserMessage[] = []; private waiting: ((r: IteratorResult<UserMessage>) => void) | undefined; private closed = false;
  push(message: UserMessage): void { if (this.closed) return; if (this.waiting) { const w = this.waiting; this.waiting = undefined; w({ value: message, done: false }); } else this.items.push(message); }
  close(): void { this.closed = true; this.waiting?.({ value: undefined as unknown as UserMessage, done: true }); this.waiting = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift() as UserMessage, done: false }) : this.closed ? Promise.resolve({ value: undefined as unknown as UserMessage, done: true }) : new Promise(r => { this.waiting = r; }) };
  }
}
const user = (content: string, priority?: UserMessage['priority']): UserMessage => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
export class ClaudeLiveSession implements LiveSession {
  readonly provider = 'claude';
  private readonly inbox = new Inbox();
  private query: Query | undefined;
  private id: string | undefined;
  private model: string | undefined;
  /** `pending` counts the messages sent in this turn that Claude hasn't answered yet: one result comes back per message. */
  private current: { text: string; pending: number; last?: string; grace?: NodeJS.Timeout; onProgress: (p: Progress) => void; done: ReturnType<typeof deferred<string>> } | undefined;
  /** How long to wait, after an answer, for Claude to start answering a message sent mid-turn. If it doesn't, the answer already covered it. */
  static GRACE_MS = 4000;
  private failure: Error | undefined;
  private started = false;
  /** Set by interrupt(): the turn's error result is the interruption, whatever its wording. */
  private interrupting = false;
  constructor(private readonly spec: SessionSpec, private readonly load: () => Promise<{ query: QueryFn }> = loadSdk) { this.model = spec.model; }
  get sessionId(): string | undefined { return this.id; }
  get busy(): boolean { return !!this.current; }
  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { query } = await this.load();
    this.query = query({
      prompt: this.inbox,
      options: {
        cwd: this.spec.cwd,
        pathToClaudeCodeExecutable: this.spec.executable,
        permissionMode: 'plan',
        includePartialMessages: true,
        ...(this.spec.model ? { model: this.spec.model } : {}),
        ...(this.spec.effort && this.spec.effort !== 'inherit' ? { effort: this.spec.effort } : {}),
        ...(this.spec.resume ? { resume: this.spec.resume, ...(this.spec.fork ? { forkSession: true } : {}) } : {}),
        canUseTool: async (name: string) => READ_ONLY_TOOLS.has(name) || name.startsWith('mcp__') && /(read|get|list|search|fetch)/i.test(name)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Turnhuddle conversations are discussion-only: describe the change instead of making it.' }
      }
    });
    void this.pump();
  }
  private async pump(): Promise<void> {
    try {
      for await (const message of this.query as Query) this.handle(message);
      this.end(new Error('Claude ended the session.'));
    } catch (error) { this.end(error instanceof Error ? error : new Error(String(error))); }
  }
  private end(error: Error): void { this.failure = error; const current = this.current; this.current = undefined; current?.done.reject(error); }
  private handle(message: SdkMessage): void {
    if (message.session_id && message.session_id !== this.id && (message.type === 'system' || !this.id)) { this.id = message.session_id; this.spec.onSession?.(message.session_id); }
    const current = this.current;
    if (!current) return;
    // Claude has started answering the mid-turn message separately: keep waiting for that answer.
    if (current.grace && (message.type === 'stream_event' || message.type === 'assistant')) { clearTimeout(current.grace); current.grace = undefined; }
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') { current.text += event.delta.text; current.onProgress({ type: 'delta', text: event.delta.text }); }
      else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') current.onProgress({ type: 'activity', text: `Using ${event.content_block.name ?? 'a tool'}` });
      else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') current.onProgress({ type: 'activity', text: 'Thinking' });
    } else if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error && typeof message.result === 'string';
      if (ok) current.last = (message.result as string) || current.text;
      // A message sent mid-turn is answered right after: wait for that answer too, and keep the final one as the reply.
      // Claude either answers a message sent mid-turn separately (another result follows) or folds it into the answer it was
      // giving (no further result). Wait briefly for a new answer to start; if none does, this answer is the reply.
      if (--current.pending > 0 && !this.interrupting && ok) {
        current.text = '';
        clearTimeout(current.grace);
        current.grace = setTimeout(() => { if (this.current === current) { this.current = undefined; current.done.resolve(current.last as string); } }, ClaudeLiveSession.GRACE_MS);
        return;
      }
      clearTimeout(current.grace);
      this.current = undefined;
      const interrupted = this.interrupting; this.interrupting = false;
      if (!ok && current.last && !interrupted) { current.done.resolve(current.last); return; }
      if (interrupted && !(message.subtype === 'success' && !message.is_error)) current.done.reject(new Error('Conversation cancelled.'));
      else if (message.subtype === 'success' && !message.is_error && typeof message.result === 'string') current.done.resolve(message.result || current.text);
      else if (message.subtype === 'error_during_execution' && /interrupt/i.test(String(message.errors ?? ''))) current.done.reject(new Error('Conversation cancelled.'));
      else current.done.reject(new Error(`Claude reported an error${typeof message.result === 'string' && message.result.trim() ? `: ${message.result.slice(0, 400)}` : message.errors?.length ? `: ${message.errors.join('; ').slice(0, 400)}` : message.subtype ? ` (${message.subtype})` : ''}. Check CLI authentication and usage limits.`));
    }
  }
  async turn(prompt: string, onProgress: (progress: Progress) => void, options: TurnOptions): Promise<string> {
    if (this.failure) throw this.failure;
    if (this.current) throw new Error('Claude is still answering the previous message.');
    await this.start();
    if (this.failure) throw this.failure;
    if (options.model !== this.model && this.query) { await this.query.setModel(options.model || undefined); this.model = options.model; }
    const current: NonNullable<ClaudeLiveSession['current']> = { text: '', pending: 1, onProgress, done: deferred<string>() };
    this.current = current;
    this.inbox.push(user(prompt));
    return current.done.promise;
  }
  /** Claude answers a message sent mid-turn as soon as the current answer is done, in the same session ("next" priority). */
  async steer(message: string): Promise<boolean> {
    if (!this.current) return false;
    this.current.pending++;
    this.inbox.push(user(message, 'next'));
    return true;
  }
  async interrupt(): Promise<void> { if (!this.current) return; this.interrupting = true; await this.query?.interrupt().catch(() => undefined); }
  close(): void { this.inbox.close(); try { this.query?.close?.(); } catch { /* already closed */ } this.end(new Error('Session closed.')); }
}
export function claudeSessions(load?: () => Promise<{ query: QueryFn }>): SessionFactory { return spec => new ClaudeLiveSession(spec, load); }
