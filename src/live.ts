// Live agent sessions, the T3 Code way: one long-lived agent per thread and seat, talked to over the agent's own protocol
// (Codex app-server JSON-RPC, the Claude Agent SDK, ACP) instead of a new CLI process per turn. No VS Code imports.
import type { Adapter, Progress } from './bridge';
export interface TurnOptions { model?: string; effort?: string }
export interface LiveSession {
  readonly provider: string;
  /** The agent's own session or thread id once known; stored so a reload can resume it. */
  readonly sessionId: string | undefined;
  /** Runs one turn: sends `text`, streams progress, resolves with the reply. One turn at a time. */
  turn(text: string, onProgress: (progress: Progress) => void, options: TurnOptions): Promise<string>;
  /** Adds a message to the running turn. Resolves false when the agent can't take it now (it will be sent next turn instead). */
  steer(text: string): Promise<boolean>;
  /** Stops the running turn; the session stays usable. */
  interrupt(): Promise<void>;
  /** True while a turn runs. */
  readonly busy: boolean;
  close(): void;
}
export interface SessionSpec { provider: string; /** The agent's CLI, as found by cliLocator. */ executable: string; cwd: string; resume?: string; fork?: boolean; model?: string; effort?: string; onSession?: (id: string) => void }
export type SessionFactory = (spec: SessionSpec) => LiveSession;
/** One live session per thread and seat. Closed when the seat changes provider, when idle too long, or on shutdown. */
export class SessionPool {
  private readonly sessions = new Map<string, { session: LiveSession; provider: string; cwd: string; idle?: NodeJS.Timeout }>();
  constructor(private readonly factories: Partial<Record<string, SessionFactory>>, private readonly idleMs = 20 * 60 * 1000) {}
  supports(provider: string): boolean { return !!this.factories[provider]; }
  key(thread: string, seat: string): string { return `${thread}:${seat}`; }
  get(thread: string, seat: string): LiveSession | undefined { return this.sessions.get(this.key(thread, seat))?.session; }
  /** The session for this thread and seat, starting one (or replacing one for another provider or folder) when needed. */
  acquire(thread: string, seat: string, spec: SessionSpec): LiveSession {
    const key = this.key(thread, seat);
    const existing = this.sessions.get(key);
    if (existing && existing.provider === spec.provider && existing.cwd === spec.cwd) { clearTimeout(existing.idle); existing.idle = undefined; return existing.session; }
    if (existing) { clearTimeout(existing.idle); existing.session.close(); this.sessions.delete(key); }
    const factory = this.factories[spec.provider];
    if (!factory) throw new Error(`No live session support for ${spec.provider}.`);
    const session = factory(spec);
    this.sessions.set(key, { session, provider: spec.provider, cwd: spec.cwd });
    return session;
  }
  /** Starts the idle timer once a round ends. */
  release(thread: string, seat: string): void {
    const entry = this.sessions.get(this.key(thread, seat));
    if (!entry || entry.session.busy) return;
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.close(thread, seat), this.idleMs);
  }
  /** The seat whose turn is running in this thread, if any. */
  active(thread: string): { seat: string; session: LiveSession } | undefined {
    for (const [key, entry] of this.sessions) if (key.startsWith(`${thread}:`) && entry.session.busy) return { seat: key.slice(thread.length + 1), session: entry.session };
    return undefined;
  }
  async interruptThread(thread: string): Promise<void> {
    await Promise.all([...this.sessions].filter(([key]) => key.startsWith(`${thread}:`)).map(([, e]) => e.session.busy ? e.session.interrupt().catch(() => undefined) : undefined));
  }
  close(thread: string, seat?: string): void {
    for (const [key, entry] of [...this.sessions]) {
      if (seat ? key !== this.key(thread, seat) : !key.startsWith(`${thread}:`)) continue;
      clearTimeout(entry.idle); entry.session.close(); this.sessions.delete(key);
    }
  }
  closeAll(): void { for (const [key, entry] of [...this.sessions]) { clearTimeout(entry.idle); entry.session.close(); this.sessions.delete(key); } }
  size(): number { return this.sessions.size; }
}
/** Wraps a live session as a relay adapter: stops the turn when the round is cancelled, and enforces the turn time limit. */
export function liveAdapter(session: LiveSession, options: TurnOptions, limits: { timeoutMs: number; maxBytes: number; signal?: AbortSignal; name: string }): Adapter {
  return async (prompt, onProgress) => {
    if (limits.signal?.aborted) throw new Error('Conversation cancelled.');
    let reason: Error | undefined;
    const stop = (error: Error) => { if (reason) return; reason = error; void session.interrupt().catch(() => undefined); };
    const onAbort = () => stop(new Error('Conversation cancelled.'));
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${limits.name} timed out after ${Math.round(limits.timeoutMs / 1000)}s.`)), limits.timeoutMs);
    try {
      const reply = await session.turn(prompt, progress => onProgress?.(progress), options);
      if (reason) throw reason;
      const size = Buffer.byteLength(reply);
      if (size > limits.maxBytes) throw new Error(`${limits.name}'s reply is ${size} bytes, more than the configured limit of ${limits.maxBytes} bytes (turnhuddle.maxOutputBytes).`);
      return reply;
    } catch (error) { throw reason ?? error; } finally { clearTimeout(timer); limits.signal?.removeEventListener('abort', onAbort); }
  };
}
/** A promise with its resolvers, for turn bookkeeping. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // A turn can fail before anyone awaits it (the agent exits while the turn is being started); don't let that become unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
