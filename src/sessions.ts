// Conversation history and multi-session state. No VS Code imports: unit-tested with Node alone.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSpec, RoundOutcome, Seat } from './bridge';
import { AgentSessions, autoTitle, ConversationState, conversationTitle, initialState, Origin, Seats, startConversation } from './conversationView';
import { isProviderId } from './providers';
/** A conversation as kept in memory and on disk. Streamed partial text is never stored. */
export interface StoredConversation extends ConversationState { id: string; task: string; cwd: string; createdAt: string; updatedAt: string; archived: boolean }
export interface SessionSummary { id: string; title: string; status: ConversationState['status']; createdAt: string; updatedAt: string; archived: boolean; bookmarked: boolean; messages: number; rounds: number; cwd: string; file?: string }
/** Conversations saved before 0.3 used provider names as roles: Claude always drafted and Codex always reviewed. */
const LEGACY_ROLES: Record<string, { role: Seat; provider: string }> = { claude: { role: 'drafter', provider: 'claude' }, codex: { role: 'reviewer', provider: 'codex' } };
const SEAT_ROLES = new Set(['user', 'drafter', 'reviewer']);
function parseAgent(value: unknown): AgentSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  if (typeof a.provider !== 'string' || !a.provider) return undefined;
  return { provider: a.provider, ...(typeof a.model === 'string' && a.model ? { model: a.model } : {}), ...(typeof a.label === 'string' && a.label ? { label: a.label } : {}) };
}
const STATUSES = new Set(['idle', 'running', 'completed', 'cancelled', 'failed']);
/** Validates a parsed JSON file. A conversation that was running when the window closed is recorded as failed. */
export function parseStored(value: unknown): StoredConversation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.task !== 'string' || !Array.isArray(v.messages)) return undefined;
  type Raw = { role: string; content: string; receivedAt: string; verdict?: unknown; agent?: unknown };
  const messages = v.messages.filter((m): m is Raw => !!m && typeof m === 'object' && typeof (m as Raw).role === 'string' && (SEAT_ROLES.has((m as Raw).role) || (m as Raw).role in LEGACY_ROLES) && typeof (m as Raw).content === 'string' && typeof (m as Raw).receivedAt === 'string')
    .map(m => {
      const legacy = LEGACY_ROLES[m.role];
      const agent = legacy ? { provider: legacy.provider } : parseAgent(m.agent);
      return { role: (legacy ? legacy.role : m.role) as 'user' | Seat, content: m.content, receivedAt: m.receivedAt, ...(m.verdict === 'agree' || m.verdict === 'continue' ? { verdict: m.verdict as 'agree' | 'continue' } : {}), ...(agent && m.role !== 'user' ? { agent } : {}) };
    });
  const oc = v.outcome as Record<string, unknown> | undefined;
  const outcome: RoundOutcome | undefined = oc && (oc.kind === 'agreed' || oc.kind === 'limit' || oc.kind === 'fixed') && typeof oc.turns === 'number' ? { kind: oc.kind as RoundOutcome['kind'], turns: oc.turns } : undefined;
  const text = (key: string) => typeof v[key] === 'string' ? v[key] as string : undefined;
  const o = v.origin as Record<string, unknown> | undefined;
  const origin: Origin | undefined = o && isProviderId(o.provider) && typeof o.sessionId === 'string' ? { provider: o.provider, sessionId: o.sessionId, title: typeof o.title === 'string' ? o.title : '' } : undefined;
  const a = v.agentSessions as Record<string, unknown> | undefined;
  const agentSessions: AgentSessions = {};
  for (const [key, value] of Object.entries(a ?? {})) {
    const legacy = LEGACY_ROLES[key];
    if (legacy && typeof value === 'string') agentSessions[legacy.role] = { provider: legacy.provider, id: value };
    else if ((key === 'drafter' || key === 'reviewer') && value && typeof value === 'object' && typeof (value as { provider?: unknown }).provider === 'string' && typeof (value as { id?: unknown }).id === 'string') agentSessions[key] = { provider: (value as { provider: string }).provider, id: (value as { id: string }).id };
  }
  const st = v.seats as Record<string, unknown> | undefined;
  const drafter = parseAgent(st?.drafter), reviewer = parseAgent(st?.reviewer);
  const seats: Seats | undefined = drafter && reviewer ? { drafter, reviewer } : undefined;
  const status = STATUSES.has(v.status as string) ? v.status as ConversationState['status'] : 'failed';
  const interrupted = status === 'running' || status === 'idle';
  return {
    id: v.id, task: v.task, cwd: text('cwd') ?? '', createdAt: text('createdAt') ?? text('startedAt') ?? new Date(0).toISOString(), updatedAt: text('updatedAt') ?? text('finishedAt') ?? text('startedAt') ?? new Date(0).toISOString(),
    archived: v.archived === true, ...(v.bookmarked === true ? { bookmarked: true } : {}), ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title.trim().slice(0, 200) } : {}), status: interrupted ? 'failed' : status, messages,
    startedAt: text('startedAt'), roundStartedAt: text('roundStartedAt'), finishedAt: text('finishedAt'),
    error: interrupted ? 'The window closed while this conversation was running.' : text('error'),
    ...(origin ? { origin } : {}), ...(Object.keys(agentSessions).length ? { agentSessions } : {}), ...(seats ? { seats } : {}), ...(outcome && !interrupted ? { outcome } : {})
  };
}
/** Strips in-memory-only fields before writing. */
export function toStored(conversation: StoredConversation): StoredConversation {
  const { partial: _partial, ...rest } = conversation;
  return rest;
}
/** One JSON file per conversation in `dir`. Files are never deleted here: archiving is a flag, and the folder can be opened for manual clean-up. */
export class HistoryStore {
  constructor(readonly dir: string) {}
  fileFor(id: string): string { return join(this.dir, `${id.replace(/[^a-zA-Z0-9-]/g, '_')}.json`); }
  async load(): Promise<StoredConversation[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const result: StoredConversation[] = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try { const parsed = parseStored(JSON.parse(await readFile(join(this.dir, name), 'utf8'))); if (parsed) result.push(parsed); } catch { /* skip unreadable files */ }
    }
    return result;
  }
  private counter = 0;
  /** Atomic replace: each write gets its own temporary file, so overlapping saves can never tear the JSON. */
  async save(conversation: StoredConversation): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(conversation.id);
    const tmp = `${file}.${process.pid}.${++this.counter}.tmp`;
    await writeFile(tmp, JSON.stringify(toStored(conversation), null, 2));
    await rename(tmp, file);
  }
}
export function summarize(conversation: StoredConversation, file?: string): SessionSummary {
  const title = conversationTitle(conversation);
  return { id: conversation.id, title: title.length > 80 ? `${title.slice(0, 79)}…` : title, status: conversation.status, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, archived: conversation.archived, bookmarked: conversation.bookmarked === true, messages: conversation.messages.length, rounds: conversation.messages.filter(m => m.role === 'user').length, cwd: conversation.cwd, file };
}
export type ListListener = () => void;
/** All conversations of this window plus the one shown in the panel. Persists through a HistoryStore when one is given. */
/** Records the CLI session the agent in `seat` used, so its next turn resumes it. */
export function withAgentSession(state: ConversationState, seat: Seat, provider: string, sessionId: string): ConversationState {
  return { ...state, agentSessions: { ...state.agentSessions, [seat]: { provider, id: sessionId } } };
}
/** Puts agents in the seats for the next round. */
export function withSeats(state: ConversationState, seats: Seats): ConversationState { return { ...state, seats }; }
export class SessionManager {
  private readonly sessions = new Map<string, StoredConversation>();
  private selected: string | undefined;
  private readonly stateListeners = new Set<(state: ConversationState) => void>();
  private readonly listListeners = new Set<ListListener>();
  private readonly pendingSaves = new Map<string, NodeJS.Timeout>();
  private readonly writeChains = new Map<string, Promise<void>>();
  constructor(private readonly store?: HistoryStore, private readonly saveDelayMs = 150) {}
  /** Reads previously saved conversations. Nothing is selected afterwards. */
  async load(): Promise<number> {
    if (!this.store) return 0;
    for (const conversation of await this.store.load()) if (!this.sessions.has(conversation.id)) this.sessions.set(conversation.id, conversation);
    this.notifyList();
    return this.sessions.size;
  }
  /** Current conversations: bookmarked first, then newest activity first. */
  list(): StoredConversation[] { return [...this.sessions.values()].filter(c => !c.archived).sort((a, b) => Number(b.bookmarked === true) - Number(a.bookmarked === true) || b.updatedAt.localeCompare(a.updatedAt)); }
  archived(): StoredConversation[] { return [...this.sessions.values()].filter(c => c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  summaries(): SessionSummary[] { return [...this.list(), ...this.archived()].map(c => summarize(c, this.store?.fileFor(c.id))); }
  getConversation(id: string): StoredConversation | undefined { return this.sessions.get(id); }
  selectedId(): string | undefined { return this.selected; }
  /** The state shown in the panel: the selected conversation, or the idle welcome state. */
  get(): ConversationState { return this.selected ? this.sessions.get(this.selected) ?? initialState() : initialState(); }
  select(id: string | undefined): boolean {
    if (id !== undefined && !this.sessions.has(id)) return false;
    this.selected = id;
    this.notifyState(); this.notifyList();
    return true;
  }
  /** Starts a new conversation and selects it; `origin` records the CLI session it continues from, which the drafter picks up. */
  create(id: string, task: string, cwd: string, at: Date = new Date(), origin?: Origin, seats?: Seats): StoredConversation {
    const conversation: StoredConversation = { ...startConversation(task, at), task, title: autoTitle(task), id, cwd, createdAt: at.toISOString(), updatedAt: at.toISOString(), archived: false, ...(seats ? { seats } : {}), ...(origin ? { origin, agentSessions: { drafter: { provider: origin.provider, id: origin.sessionId } } } : {}) };
    this.sessions.set(id, conversation);
    this.selected = id;
    this.persist(id); this.notifyState(); this.notifyList();
    return conversation;
  }
  /** Applies a view-model change to one conversation. */
  update(id: string, change: (state: ConversationState) => ConversationState, at: Date = new Date()): void {
    const current = this.sessions.get(id);
    if (!current) return;
    const next = change(current) as StoredConversation;
    const updated: StoredConversation = { ...next, id, task: next.task ?? current.task, cwd: current.cwd, createdAt: current.createdAt, archived: current.archived, origin: current.origin, agentSessions: next.agentSessions ?? current.agentSessions, updatedAt: next.partial && !('partial' in current) ? current.updatedAt : at.toISOString() };
    this.sessions.set(id, updated);
    if (!updated.partial || current.partial === undefined) this.persist(id);
    if (id === this.selected) this.notifyState();
    if (!updated.partial) this.notifyList();
  }
  /** Renames a conversation. An empty name goes back to the automatic one. Doesn't change its activity time. */
  setTitle(id: string, title: string): boolean {
    const current = this.sessions.get(id);
    if (!current) return false;
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 200);
    this.sessions.set(id, { ...current, title: name || autoTitle(current.task) });
    this.persist(id, true); if (id === this.selected) this.notifyState(); this.notifyList();
    return true;
  }
  /** Changes who sits in the seats for the conversation's next round. Doesn't change its activity time. */
  setSeats(id: string, seats: Seats): boolean {
    const current = this.sessions.get(id);
    if (!current) return false;
    this.sessions.set(id, { ...current, seats });
    this.persist(id, true); if (id === this.selected) this.notifyState();
    return true;
  }
  /** Marks a conversation as bookmarked (or not). Doesn't change its activity time. */
  setBookmarked(id: string, bookmarked: boolean): boolean {
    const current = this.sessions.get(id);
    if (!current) return false;
    const { bookmarked: _old, ...rest } = current;
    this.sessions.set(id, bookmarked ? { ...rest, bookmarked: true } : rest);
    this.persist(id, true); if (id === this.selected) this.notifyState(); this.notifyList();
    return true;
  }
  setArchived(id: string, archived: boolean): boolean {
    const current = this.sessions.get(id);
    if (!current) return false;
    this.sessions.set(id, { ...current, archived, updatedAt: new Date().toISOString() });
    if (archived && this.selected === id) this.selected = undefined;
    this.persist(id, true); this.notifyState(); this.notifyList();
    return true;
  }
  subscribe(listener: (state: ConversationState) => void): () => void { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; }
  onDidChangeList(listener: ListListener): () => void { this.listListeners.add(listener); return () => { this.listListeners.delete(listener); }; }
  /** Writes everything that is still pending; call on deactivate. */
  async flush(): Promise<void> {
    const ids = [...this.pendingSaves.keys()];
    for (const id of ids) { clearTimeout(this.pendingSaves.get(id)); this.pendingSaves.delete(id); }
    for (const id of ids) void this.write(id);
    await Promise.all([...this.writeChains.values()]);
  }
  private persist(id: string, now = false): void {
    if (!this.store) return;
    if (now) { clearTimeout(this.pendingSaves.get(id)); this.pendingSaves.delete(id); void this.write(id); return; }
    if (this.pendingSaves.has(id)) return;
    this.pendingSaves.set(id, setTimeout(() => { this.pendingSaves.delete(id); void this.write(id); }, this.saveDelayMs));
  }
  /** Saves are chained per conversation so the newest state always lands last. */
  private write(id: string): Promise<void> {
    const chain = (this.writeChains.get(id) ?? Promise.resolve()).then(async () => {
      const conversation = this.sessions.get(id);
      if (!conversation || !this.store) return;
      try { await this.store.save(conversation); } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
    });
    this.writeChains.set(id, chain);
    return chain;
  }
  /** Most recent persistence failure, for diagnostics. */
  lastError: string | undefined;
  private notifyState(): void { const state = this.get(); for (const listener of [...this.stateListeners]) listener(state); }
  private notifyList(): void { for (const listener of [...this.listListeners]) listener(); }
}

export type HistoryEntry = { kind: 'separator'; label: string } | { kind: 'conversation'; conversation: StoredConversation };
/** The history list behind the chat header's clock: bookmarked conversations, then the rest, newest first; archived ones left out. */
export function historyEntries(conversations: StoredConversation[]): HistoryEntry[] {
  const live = conversations.filter(c => !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const marked = live.filter(c => c.bookmarked), rest = live.filter(c => !c.bookmarked);
  const out: HistoryEntry[] = [];
  if (marked.length) out.push({ kind: 'separator', label: 'Bookmarked' }, ...marked.map(conversation => ({ kind: 'conversation', conversation }) as HistoryEntry));
  if (rest.length) out.push({ kind: 'separator', label: 'Recent' }, ...rest.map(conversation => ({ kind: 'conversation', conversation }) as HistoryEntry));
  return out;
}

/** Conversation id from a command argument: an id string, or an object carrying `id` or `conversation.id`. */
export function conversationIdFrom(argument: unknown): string | undefined {
  if (typeof argument === 'string') return argument;
  if (argument && typeof argument === 'object') {
    const a = argument as { id?: unknown; conversation?: { id?: unknown } };
    if (typeof a.id === 'string') return a.id;
    if (a.conversation && typeof a.conversation.id === 'string') return a.conversation.id;
  }
  return undefined;
}
