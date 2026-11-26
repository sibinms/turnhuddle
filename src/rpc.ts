// JSON-RPC over a child process's stdio, one JSON object per line. Used for `codex app-server` and ACP agents. No VS Code imports.
import { ChildProcess, spawn } from 'node:child_process';
export interface RpcOptions {
  /** Include `"jsonrpc": "2.0"` in every message (ACP requires it; Codex app-server omits it). */
  jsonrpc?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Answers requests the agent sends us (approvals, permission prompts). Throw to return an error. */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  /** Called once when the process exits or can't start. */
  onExit?: (error: Error) => void;
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };
export class RpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0; private buffer = ''; private stderrTail = ''; private exited: Error | undefined;
  constructor(readonly executable: string, args: string[], private readonly options: RpcOptions = {}) {
    this.child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000); });
    this.child.on('error', error => this.fail(new Error(`Cannot run ${executable}: ${error.message}`)));
    this.child.on('exit', (code, signal) => this.fail(new Error(`${executable} stopped (${code === null ? `signal ${signal}` : `exit code ${code}`}).${this.stderrTail.trim() ? ` Last output: ${this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 400)}` : ''}`)));
    this.child.stdin?.on('error', () => undefined);
  }
  get alive(): boolean { return !this.exited; }
  get pid(): number | undefined { return this.child.pid; }
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  notify(method: string, params?: unknown): void { if (!this.exited) this.write({ method, ...(params === undefined ? {} : { params }) }); }
  close(): void {
    if (this.exited) return;
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    this.fail(new Error('Session closed.'));
  }
  private write(message: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(this.options.jsonrpc ? { jsonrpc: '2.0', ...message } : message)}\n`);
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id !== undefined) void this.answer(message.id, message.method, message.params);
      else if (message.method) this.options.onNotification?.(message.method, message.params);
      else if (message.id !== undefined) {
        const waiting = this.pending.get(Number(message.id));
        if (!waiting) continue;
        this.pending.delete(Number(message.id));
        if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
        else waiting.resolve(message.result);
      }
    }
  }
  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (!this.options.onRequest) throw new Error(`Unsupported request ${method}`);
      this.write({ id, result: await this.options.onRequest(method, params) });
    } catch (error) { this.write({ id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } }); }
  }
  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = error;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.options.onExit?.(error);
  }
}
