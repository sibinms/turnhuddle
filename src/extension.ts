import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentSpec, ContextMode, Conversation, DEFAULT_MAX_TURNS, Message, relay, RoundMode, run, Seat, SessionOptions } from './bridge';
import { ConversationState, conversationTitle, finishConversation, MAX_TASK_CHARS, Origin, receiveMessage, receiveProgress, resumeConversation, Seats, seatsOf } from './conversationView';
import { conversationIdFrom, historyEntries, HistoryStore, SessionManager, SessionSummary, StoredConversation, withAgentSession, withSeats } from './sessions';
import { agentAdapter, agentName, DEFAULT_SEATS, formatAgentSetting, parseAgentSetting, provider, PROVIDER_IDS, PROVIDERS, ProviderId, sameAgent, seatNames } from './providers';
import { claudeModelLabel, discoverModels, ModelChoice } from './models';
import { listVendorSessions, VendorSession } from './vendorSessions';
import { CHAT_VIEW_PRIMARY, CHAT_VIEW_SECONDARY, ConversationViewProvider } from './sidebar';
import { ThreadsView } from './threadsView';
import { liveAdapter, LiveSession, SessionPool } from './live';
import { codexSessions } from './codexLive';
import { claudeSessions } from './claudeLive';
import { geminiSessions } from './acpLive';
import { supportsSecondarySidebar } from './threads';
import { checkDue, checkForUpdate, downloadVsix, Fetcher, UpdateCheck } from './updates';
import { Agent, defaultExtensionRoots, EXTENSION_IDS, locate, Located, loginShellLookup, SOURCE_LABELS } from './cliLocator';
/** Returned by `turnhuddle.start` and `turnhuddle.reply` so callers (keybindings, automation, tests) can inspect the outcome of the round they ran. */
export type StartResult = { status: 'completed' | 'cancelled' | 'failed' | 'skipped'; id?: string; messages: Message[]; error?: string };
/** `task`/`message` skip the input box; `source: 'sidebar'` means the chat panel sent it, so the Output channel is written to but not raised. */
export type StartOptions = { task?: string; source?: 'sidebar' };
export type ReplyOptions = { message?: string; source?: 'sidebar'; id?: string };
/** `provider` + `sessionId` skip the picker; `message` skips the input box; `all` lists sessions from every folder. */
export type ContinueOptions = { provider?: 'claude' | 'codex'; sessionId?: string; title?: string; message?: string; source?: 'sidebar'; all?: boolean };
/** Exported from `activate` for automation and the live test suite. */
export interface TurnhuddleApi {
  getState(): ConversationState; onDidChangeState(listener: (state: ConversationState) => void): vscode.Disposable;
  isViewResolved(): boolean; isViewVisible(): boolean;
  listSessions(): SessionSummary[]; runningIds(): string[]; historyDir(): string;
  listVendorSessions(all?: boolean): Promise<VendorSession[]>;
  checkForUpdates(): Promise<UpdateCheck>;
  /** Webview URIs of the logos the chat panel uses (empty until the panel has been shown). */
  logoSources(): Record<string, string>;
  /** Who sits in each seat: for the open conversation, or for new ones when none is open. */
  seats(): Seats;
  /** Live agent sessions open now, and closing them all (the agents' processes exit). */
  liveSessionCount(): number; closeLiveSessions(): void;
  /** The chat panel in use: the secondary side bar's on VS Code 1.106+, else the activity bar's. */
  chatViewId(): string;
  /** Models each provider offers on this machine. */
  models(provider: ProviderId): Promise<ModelChoice[]>;
}
const running = new Map<string, AbortController>();
/** Live agent sessions (the default engine): one per thread and seat. */
let poolRef: SessionPool | undefined;
/** Messages sent while a round ran, waiting for the next turn of that thread. */
const queued = new Map<string, string[]>();
let sessionsRef: SessionManager | undefined;
export function activate(context: vscode.ExtensionContext): TurnhuddleApi {
  const output = vscode.window.createOutputChannel('Turnhuddle');
  context.subscriptions.push(output);
  const historyDir = vscode.Uri.joinPath(context.globalStorageUri, 'conversations').fsPath;
  const sessions = new SessionManager(new HistoryStore(historyDir));
  sessionsRef = sessions;
  const loaded = sessions.load().then(count => { if (count) output.appendLine(`Loaded ${count} saved conversation${count === 1 ? '' : 's'} from ${historyDir}`); }, error => output.appendLine(`Could not load saved conversations: ${String(error)}`));
  const settings = () => vscode.workspace.getConfiguration('turnhuddle');
  const pool = new SessionPool({ claude: claudeSessions(), codex: codexSessions([], String(context.extension.packageJSON.version ?? '0.0.0')), gemini: geminiSessions() });
  poolRef = pool;
  context.subscriptions.push({ dispose: () => pool.closeAll() });
  // ---------- seats and models ----------
  const modelCache = new Map<ProviderId, ModelChoice[]>();
  const models = async (id: ProviderId, refresh = false): Promise<ModelChoice[]> => {
    if (!refresh && modelCache.has(id)) return modelCache.get(id) as ModelChoice[];
    const list = await discoverModels(id, homedir());
    modelCache.set(id, list);
    return list;
  };
  for (const id of PROVIDER_IDS) void models(id);
  /** Adds the model's display name, from the discovered list when known. */
  const labelled = (spec: AgentSpec): AgentSpec => {
    if (!spec.model) { const { label: _l, ...rest } = spec; return rest; }
    const known = modelCache.get(spec.provider as ProviderId)?.find(m => m.id === spec.model)?.label;
    return { ...spec, label: known ?? (spec.provider === 'claude' ? claudeModelLabel(spec.model) : spec.model) };
  };
  /** Seats for new conversations, from turnhuddle.drafter and turnhuddle.reviewer. */
  const defaultSeats = (): Seats => ({ drafter: labelled(parseAgentSetting(settings().get<string>('drafter'), DEFAULT_SEATS.drafter)), reviewer: labelled(parseAgentSetting(settings().get<string>('reviewer'), DEFAULT_SEATS.reviewer)) });
  /** Seats for a conversation continuing a CLI session: that CLI drafts (keeping its session's model); the reviewer is the configured one, or the other configured agent when that is the same CLI. */
  const originSeats = (from: string): Seats => {
    const d = defaultSeats();
    const reviewer = d.reviewer.provider !== from ? d.reviewer : d.drafter.provider !== from ? d.drafter : d.reviewer;
    return { drafter: { provider: from }, reviewer };
  };
  const seatsShown = (state: ConversationState): Seats => state.status === 'idle' ? defaultSeats() : seatsOf(state);
  // The chat sits in the secondary side bar (right) on VS Code 1.106+, like Claude Code's; older versions get an activity-bar container.
  const secondary = supportsSecondarySidebar(vscode.version);
  if (!secondary) void vscode.commands.executeCommand('setContext', 'turnhuddle.noSecondarySidebar', true);
  const chatViews = [new ConversationViewProvider(sessions, { seats: seatsShown }, CHAT_VIEW_SECONDARY), new ConversationViewProvider(sessions, { seats: seatsShown }, CHAT_VIEW_PRIMARY)];
  for (const v of chatViews) v.register(context);
  /** The chat panel for this VS Code: whichever has been shown, else the one its layout uses. */
  const chatView = () => chatViews.find(v => v.resolved) ?? chatViews[secondary ? 0 : 1];
  const view = { reveal: () => chatView().reveal(), get resolved() { return chatView().resolved; }, get visible() { return chatView().visible; }, get logoSources() { return chatView().logoSources; } };
  const threads = new ThreadsView(sessions, id => running.has(id));
  threads.register(context);
  const syncRunning = () => { void vscode.commands.executeCommand('setContext', 'turnhuddle.running', !!sessions.selectedId() && running.has(sessions.selectedId() as string)); };
  context.subscriptions.push({ dispose: sessions.subscribe(() => syncRunning()) });
  syncRunning();
  const ask = (title: string, prompt: string) => vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, validateInput: value => value.trim() ? (value.length > MAX_TASK_CHARS ? `Keep it below ${MAX_TASK_CHARS.toLocaleString()} characters.` : undefined) : 'Enter a message.' });
  // ---------- finding the CLIs ----------
  const shellLookup = process.platform === 'win32' ? undefined : loginShellLookup();
  const found = new Map<string, Located>();
  /** The CLI to run for an agent, from the setting or found automatically (cached while the file exists). */
  const findCli = async (agent: Agent): Promise<Located | undefined> => {
    const configured = settings().get<string>(`${agent}Path`, agent);
    const key = `${agent}:${configured}`;
    const cached = found.get(key);
    if (cached && (cached.source === 'setting' || existsSync(cached.path))) return cached;
    const ext = EXTENSION_IDS[agent];
    const result = await locate(agent, configured, { home: homedir(), platform: process.platform, envPath: process.env.PATH, shellLookup, extensionDirs: ext ? { [agent]: vscode.extensions.getExtension(ext)?.extensionPath } : {}, extensionRoots: defaultExtensionRoots(homedir()) });
    if (result) found.set(key, result); else found.delete(key);
    if (result && result.source !== 'setting' && !cached) output.appendLine(`Using ${PROVIDERS[agent].product} CLI ${SOURCE_LABELS[result.source]}: ${result.path}`);
    return result;
  };
  const missingCliMessage = (agent: Agent) => { const p = PROVIDERS[agent]; return `Turnhuddle couldn't find the ${p.product} CLI. Install ${EXTENSION_IDS[agent] ? `the ${p.product} CLI or the ${p.product} VS Code extension` : `it (${p.installUrl})`} and sign in, or set turnhuddle.${agent}Path to the executable.`; };
  const reportMissing = async (agent: Agent) => {
    output.appendLine(missingCliMessage(agent));
    const choice = await vscode.window.showErrorMessage(missingCliMessage(agent), 'Open Settings', 'Check Again');
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', `turnhuddle.${agent}Path`);
    else if (choice === 'Check Again') { found.clear(); await vscode.commands.executeCommand('turnhuddle.check'); }
  };
  const workspaceFolder = () => { const folders = vscode.workspace.workspaceFolders; return folders?.length === 1 && folders[0].uri.scheme === 'file' ? folders[0].uri.fsPath : undefined; };
  const vendorSessions = (all?: boolean) => listVendorSessions({ home: homedir(), cwd: all ? undefined : workspaceFolder(), limit: 30 });
  /** Runs one round: a new conversation when `id` is undefined (continuing from `origin` when given), otherwise a follow-up on that conversation. Several conversations may run at once; one conversation runs one round at a time. */
  const round = async (id: string | undefined, preset: string | undefined, source: 'sidebar' | undefined, title: string, prompt: string, origin?: Origin): Promise<StartResult> => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('Trust this workspace before running the bridge.'); return { status: 'skipped', messages: [] }; }
    if (id && running.has(id)) { void vscode.window.showInformationMessage('This conversation is already running a round.'); return { status: 'skipped', id, messages: [] }; }
    const existing = id ? sessions.getConversation(id) : undefined;
    if (id && !existing) { void vscode.window.showErrorMessage('That conversation is no longer available.'); return { status: 'skipped', messages: [] }; }
    const messages: Message[] = [];
    let conversationId = id;
    try {
      const folders = vscode.workspace.workspaceFolders;
      const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder || folder.uri.scheme !== 'file') { void vscode.window.showErrorMessage('Open a local folder to run Turnhuddle.'); return { status: 'skipped', messages }; }
      if (preset && preset.length > MAX_TASK_CHARS) { void vscode.window.showErrorMessage(`Keep it below ${MAX_TASK_CHARS.toLocaleString()} characters.`); return { status: 'skipped', messages }; }
      const text = preset ?? await ask(title, prompt);
      if (!text) return { status: 'skipped', messages };
      if (id && running.has(id)) return { status: 'skipped', id, messages };
      const conversationOrigin = origin ?? existing?.origin;
      const seats: Seats = existing ? seatsOf(existing) : origin ? originSeats(origin.provider) : defaultSeats();
      const clis: Partial<Record<Seat, Located>> = {};
      for (const seat of ['drafter', 'reviewer'] as const) {
        const def = provider(seats[seat].provider);
        if (!def) { const error = `Unknown agent "${seats[seat].provider}" in the ${seat} seat. Pick another from the chat.`; void vscode.window.showErrorMessage(error); return { status: 'failed', id: conversationId, messages, error }; }
        const cli = await findCli(def.id);
        if (!cli) { void reportMissing(def.id); return { status: 'failed', id: conversationId, messages, error: missingCliMessage(def.id) }; }
        if (cli.source === 'setting' && /[\\/]/.test(cli.path) && !existsSync(cli.path)) {
          const error = `Cannot run ${cli.path}: no such file. Check turnhuddle.${def.id}Path, or clear it to find the ${def.product} CLI automatically.`;
          if (!conversationId) { conversationId = randomUUID(); sessions.create(conversationId, text, existing?.cwd && existsSync(existing.cwd) ? existing.cwd : folder.uri.fsPath, new Date(), origin, seats); }
          sessions.update(conversationId, state => finishConversation(receiveMessage(state, conversationId as string, { role: 'user', content: text }), 'failed', new Date(), error));
          output.appendLine(error); if (source !== 'sidebar') void vscode.window.showErrorMessage(error);
          return { status: 'failed', id: conversationId, messages: [{ role: 'user', content: text }], error };
        }
        clis[seat] = cli;
      }
      const cwd = existing?.cwd && existsSync(existing.cwd) ? existing.cwd : folder.uri.fsPath;
      const config = settings();
      const controller = new AbortController();
      if (!conversationId) { conversationId = randomUUID(); sessions.create(conversationId, text, cwd, new Date(), origin, seats); }
      else { sessions.update(conversationId, state => withSeats(resumeConversation(state), seats)); if (existing?.archived) sessions.setArchived(conversationId, false); sessions.select(conversationId); }
      const target: Conversation = { id: conversationId, history: (existing?.messages ?? []).map(m => ({ role: m.role, content: m.content, ...(m.agent ? { agent: m.agent } : {}) })) };
      const thisId = conversationId;
      const names = seatNames(seats);
      // A conversation continued from a CLI session: Claude's first turn forks the user's session (the original stays untouched) and later
      // turns resume the fork; Codex resumes its thread in place.
      // Every seat keeps its own CLI session for the thread (turnhuddle.keepAgentSessions): the first turn starts it with the history so
      // far, later turns resume it and send only what's new. A seat whose provider changed starts fresh with the history (a handoff).
      const keepSessions = config.get<boolean>('keepAgentSessions', true);
      const sessionFor = (seat: Seat): (() => SessionOptions | undefined) => () => {
        const def = provider(seats[seat].provider);
        if ((!conversationOrigin && !keepSessions) || !def?.resume) return undefined;
        const current = sessions.getConversation(thisId)?.agentSessions?.[seat];
        const onSession = (sessionId: string) => sessions.update(thisId, state => withAgentSession(state, seat, def.id, sessionId));
        if (!current || current.provider !== def.id) return { onSession };
        return { resume: current.id, fork: def.resume === 'fork' && !!conversationOrigin && current.id === conversationOrigin.sessionId && conversationOrigin.provider === def.id, onSession };
      };
      const contextFor = (seat: Seat): ContextMode => (conversationOrigin || keepSessions) && provider(seats[seat].provider)?.resume && sessions.getConversation(thisId)?.agentSessions?.[seat]?.provider === seats[seat].provider ? 'delta' : 'replay';
      const effortFor = (id: string): string | undefined => { const key = provider(id)?.effortSetting; return key ? config.get<string>(key, id === 'codex' ? 'medium' : 'inherit') : undefined; };
      // The live engine (default, like T3 Code): each seat talks to one long-lived agent for the whole thread — Codex through
      // `codex app-server`, Claude through the Claude Agent SDK, Gemini and other agents through ACP. `turnhuddle.engine: "cli"`
      // runs a CLI process per turn instead (resuming each seat's session when keepAgentSessions is on).
      const live = config.get<string>('engine', 'live') !== 'cli';
      const knows = new Map<Seat, LiveSession>();
      const liveFor = (seat: Seat): LiveSession | undefined => {
        const spec = seats[seat];
        if (!live || !pool.supports(spec.provider)) return undefined;
        const recorded = sessions.getConversation(thisId)?.agentSessions?.[seat];
        const resume = recorded?.provider === spec.provider ? recorded.id : undefined;
        const fork = !!conversationOrigin && conversationOrigin.provider === spec.provider && resume === conversationOrigin.sessionId && provider(spec.provider)?.resume === 'fork';
        const before = pool.get(thisId, seat);
        const session = pool.acquire(thisId, seat, { provider: spec.provider, executable: (clis[seat] as Located).path, cwd, resume, fork, model: spec.model, effort: effortFor(spec.provider), onSession: id => sessions.update(thisId, state => withAgentSession(state, seat, spec.provider, id)) });
        if (session === before || resume) knows.set(seat, session);
        return session;
      };
      const adapterFor = (seat: Seat) => {
        const spec = seats[seat];
        const session = liveFor(seat);
        if (!session) return agentAdapter(PROVIDERS[spec.provider as ProviderId], (clis[seat] as Located).path, limits, { model: spec.model, effort: effortFor(spec.provider) }, sessionFor(seat));
        const turn = liveAdapter(session, { model: spec.model, effort: effortFor(spec.provider) }, { ...limits, name: names[seat] });
        return async (prompt: string, onProgress?: (p: import('./bridge').Progress) => void) => { const reply = await turn(prompt, onProgress); knows.set(seat, session); return reply; };
      };
      /** A live agent that already holds the conversation (resumed, or answered earlier in this thread) gets only what's new. */
      const contextNow = (seat: Seat): ContextMode => live && pool.supports(seats[seat].provider) ? (knows.has(seat) ? 'delta' : 'replay') : contextFor(seat);
      const limits = { cwd, timeoutMs: config.get<number>('timeoutSeconds', 180) * 1000, maxBytes: config.get<number>('maxOutputBytes', 1048576), signal: controller.signal };
      running.set(conversationId, controller);
      let outcome: import('./bridge').RoundOutcome | undefined;
      syncRunning();
      if (source !== 'sidebar') output.show(true);
      void view.reveal();
      try {
        // Rounds started from the chat report no progress to VS Code at all: any progress indicator (popup or the view's bar)
        // makes VS Code loop its progress sound when accessibility signals are on. The composer already shows the spinner,
        // turn, timer and Stop, and announces the agent's status. Command Palette starts keep the cancellable popup.
        const quiet = source === 'sidebar';
        const silent = <T>(task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<T>) => {
          const never = new vscode.CancellationTokenSource();
          return task({ report: () => undefined }, never.token).finally(() => never.dispose());
        };
        const withRoundProgress = quiet ? silent : <T>(task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<T>) =>
          vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Turnhuddle', cancellable: true }, task);
        await withRoundProgress(async (progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            const who = (role: Message['role']) => role === 'user' ? 'you' : names[role];
            const result = await relay(target, text, { drafter: adapterFor('drafter'), reviewer: adapterFor('reviewer') }, (_id, message) => {
              messages.push(message);
              sessions.update(thisId, state => receiveMessage(state, thisId, message));
              output.appendLine(`\n[${thisId}] ${who(message.role)}${message.verdict ? ` (${message.verdict})` : ''}\n${message.content}`);
              progress.report({ message: `${who(message.role)}: message received` });
            }, (_id, seat, update) => {
              sessions.update(thisId, state => receiveProgress(state, seat, update));
              if (update.type === 'activity') progress.report({ message: `${names[seat]}: ${update.text}` });
            }, { seats, names, contextFor: contextNow, takeQueued: () => { const list = queued.get(thisId) ?? []; queued.delete(thisId); return list; }, mode: config.get<RoundMode>('roundMode', 'agreement'), maxTurns: config.get<number>('maxTurnsPerRound', DEFAULT_MAX_TURNS), onTurn: (turn, seat) => progress.report({ message: `turn ${turn}: ${names[seat]}` }) });
            outcome = result.outcome;
            output.appendLine(outcome.kind === 'agreed' ? `\nBoth agreed after ${outcome.turns} turns.` : outcome.kind === 'limit' ? `\nNo agreement after ${outcome.turns} turns (limit reached).` : '\nConversation complete.');
          } finally { subscription.dispose(); }
        });
        sessions.update(thisId, state => finishConversation(state, 'completed', new Date(), undefined, outcome));
        return { status: 'completed', id: thisId, messages };
      } catch (error) {
        const text = String(error);
        if (controller.signal.aborted) {
          sessions.update(thisId, state => finishConversation(state, 'cancelled', new Date(), text));
          output.appendLine('\nConversation cancelled. Later turns were not started.');
          if (source !== 'sidebar') void vscode.window.showInformationMessage('Turnhuddle conversation cancelled.');
          return { status: 'cancelled', id: thisId, messages, error: text };
        }
        sessions.update(thisId, state => finishConversation(state, 'failed', new Date(), text));
        output.appendLine(`\n${text}`);
        if (source !== 'sidebar') void vscode.window.showErrorMessage(text);
        return { status: 'failed', id: thisId, messages, error: text };
      } finally { if (running.get(thisId) === controller) running.delete(thisId); pool.release(thisId, 'drafter'); pool.release(thisId, 'reviewer'); syncRunning(); }
    } catch (error) {
      const text = String(error);
      output.appendLine(`\n${text}`);
      void vscode.window.showErrorMessage(text);
      return { status: 'failed', id: conversationId, messages, error: text };
    }
  };
  const register = (command: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  register('turnhuddle.focus', async (): Promise<boolean> => { await view.reveal(); return true; });
  register('turnhuddle.newThread', async (): Promise<boolean> => { sessions.select(undefined); await view.reveal(); return true; });
  register('turnhuddle.unbookmark', (argument?: unknown): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand('turnhuddle.toggleBookmark', argument, false)));
  register('turnhuddle.toggleArchived', (): boolean => { threads.setShowArchived(!threads.showArchived); return threads.showArchived; });
  register('turnhuddle.getState', (): ConversationState => sessions.get());
  register('turnhuddle.listSessions', (): SessionSummary[] => sessions.summaries());
  register('turnhuddle.check', async (): Promise<string[]> => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('Trust this workspace before checking the CLIs.'); return []; }
    output.show(true);
    const lines: string[] = [];
    const report = (line: string) => { lines.push(line); output.appendLine(line); };
    found.clear();
    const seated = new Set(Object.values(defaultSeats()).map(s => s.provider));
    for (const agent of PROVIDER_IDS) {
      const cli = await findCli(agent);
      if (!cli) { report(`${agent}: not found.${seated.has(agent) ? ` ${missingCliMessage(agent)}` : ` Optional: install the ${PROVIDERS[agent].product} to seat ${PROVIDERS[agent].name} (${PROVIDERS[agent].installUrl}).`}`); continue; }
      try { report(`${agent}: ${await run(cli.path, ['--version'], '', { cwd: context.extensionPath, timeoutMs: 10000, maxBytes: 65536 })} (${SOURCE_LABELS[cli.source]}: ${cli.path})`); }
      catch (error) { report(`${agent}: ${String(error)} (${SOURCE_LABELS[cli.source]}: ${cli.path})`); }
    }
    report('Version checks do not verify authentication. Sign in with each CLI in a terminal.');
    return lines;
  });
  /** Stops the selected conversation's round (or the given one). */
  register('turnhuddle.cancel', (argument?: unknown): boolean => {
    const id = conversationIdFrom(argument) ?? sessions.selectedId();
    const controller = id ? running.get(id) : undefined;
    if (!controller) { void vscode.window.showInformationMessage('No Turnhuddle conversation is running here.'); return false; }
    controller.abort();
    void pool.interruptThread(id as string);
    return true;
  });
  /** Returns the panel to the welcome state. The conversation stays in the history; nothing is deleted. */
  register('turnhuddle.clear', (): boolean => { sessions.select(undefined); return true; });
  register('turnhuddle.open', (argument?: unknown): boolean => {
    const id = conversationIdFrom(argument);
    if (!id || !sessions.select(id)) return false;
    void view.reveal();
    return true;
  });
  /** Sends a message while a round runs: into the running turn when the agent can take it (Claude, Codex), else before the next turn. Both agents see it from their next turn. */
  register('turnhuddle.steer', async (options?: unknown): Promise<'steered' | 'queued' | 'skipped'> => {
    const o = (options ?? {}) as { message?: string; id?: string };
    const id = o.id ?? sessions.selectedId();
    const message = typeof o.message === 'string' ? o.message.trim() : '';
    if (!id || !message) return 'skipped';
    if (!running.has(id)) { void vscode.commands.executeCommand('turnhuddle.reply', { message, source: 'sidebar', id }); return 'skipped'; }
    queued.set(id, [...(queued.get(id) ?? []), message]);
    sessions.update(id, state => receiveMessage(state, id, { role: 'user', content: message, steer: true }));
    const active = pool.active(id);
    const steered = active ? await active.session.steer(message).catch(() => false) : false;
    output.appendLine(`\n[${id}] you (${steered ? 'steered into the running turn' : 'queued for the next turn'})\n${message}`);
    return steered ? 'steered' : 'queued';
  });
  register('turnhuddle.archive', (argument?: unknown): boolean => {
    const id = conversationIdFrom(argument) ?? sessions.selectedId();
    if (!id) return false;
    if (running.has(id)) { void vscode.window.showInformationMessage('Stop the running round before archiving.'); return false; }
    pool.close(id);
    return sessions.setArchived(id, true);
  });
  /** Bookmarks the open conversation (or the given one), or removes its bookmark. Returns the new state. */
  register('turnhuddle.toggleBookmark', (argument?: unknown, value?: unknown): boolean | undefined => {
    const id = conversationIdFrom(argument) ?? sessions.selectedId();
    const c = id ? sessions.getConversation(id) : undefined;
    if (!id || !c) { void vscode.window.showInformationMessage('Open a conversation to bookmark it.'); return undefined; }
    const next = typeof value === 'boolean' ? value : !c.bookmarked;
    sessions.setBookmarked(id, next);
    return next;
  });
  /** Renames the open conversation (or the given one). An empty name restores the automatic title. */
  register('turnhuddle.rename', async (argument?: unknown, name?: unknown): Promise<string | undefined> => {
    const id = conversationIdFrom(argument) ?? sessions.selectedId();
    const c = id ? sessions.getConversation(id) : undefined;
    if (!id || !c) { void vscode.window.showInformationMessage('Open a conversation to rename it.'); return undefined; }
    const value = typeof name === 'string' ? name : await vscode.window.showInputBox({ title: 'Rename conversation', value: conversationTitle(c), prompt: 'Leave empty to name it after its first message.', valueSelection: [0, conversationTitle(c).length] });
    if (value === undefined) return undefined;
    sessions.setTitle(id, value);
    return conversationTitle(sessions.getConversation(id) ?? c);
  });
  /** Claude Code-style history, the one place for past conversations: bookmarked first, then recent. Each row can be
   * bookmarked or archived in place; "Show archived" lists archived conversations to restore. Picking a row opens it. */
  register('turnhuddle.history', async (): Promise<string | undefined> => {
    const age = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
    type Item = vscode.QuickPickItem & { id?: string; action?: 'continue' | 'archived' | 'back' };
    const button = (icon: string, tooltip: string): vscode.QuickInputButton => ({ iconPath: new vscode.ThemeIcon(icon), tooltip });
    const BOOKMARK = button('bookmark', 'Bookmark'), UNBOOKMARK = button('bookmark', 'Remove bookmark'), ARCHIVE = button('archive', 'Archive (kept on disk; restore from Show archived)'), RESTORE = button('history', 'Restore');
    const describe = (c: StoredConversation) => {
      const roundCount = c.messages.filter(m => m.role === 'user').length;
      const state = running.has(c.id) ? 'running' : c.outcome?.kind === 'agreed' ? 'agreed' : c.outcome?.kind === 'limit' ? 'no agreement' : c.status;
      return [age(c.updatedAt), `${roundCount} round${roundCount === 1 ? '' : 's'}`, state, c.origin ? `from ${provider(c.origin.provider)?.product ?? c.origin.provider}` : '', c.seats ? `${agentName(c.seats.drafter)} ⇄ ${agentName(c.seats.reviewer)}` : ''].filter(Boolean).join(' · ');
    };
    const label = (c: StoredConversation) => { const t = conversationTitle(c); return `$(${c.archived ? 'archive' : c.bookmarked ? 'bookmark' : 'comment-discussion'}) ${t.length > 72 ? `${t.slice(0, 71)}…` : t}`; };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'Conversation history'; pick.matchOnDetail = true;
    let showArchived = false;
    const build = () => {
      const items: Item[] = [];
      if (showArchived) {
        items.push({ label: '$(arrow-left) Back to conversations', action: 'back', alwaysShow: true }, { label: 'Archived', kind: vscode.QuickPickItemKind.Separator });
        for (const c of sessions.archived()) items.push({ id: c.id, label: label(c), detail: describe(c), buttons: [RESTORE] });
        pick.placeholder = sessions.archived().length ? 'Search archived conversations' : 'No archived conversations';
      } else {
        for (const entry of historyEntries(sessions.list())) {
          if (entry.kind === 'separator') { items.push({ label: entry.label, kind: vscode.QuickPickItemKind.Separator }); continue; }
          const c = entry.conversation;
          items.push({ id: c.id, label: label(c), detail: describe(c), buttons: running.has(c.id) ? [c.bookmarked ? UNBOOKMARK : BOOKMARK] : [c.bookmarked ? UNBOOKMARK : BOOKMARK, ARCHIVE] });
        }
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(debug-continue) Continue from a Claude Code or Codex session…', action: 'continue', alwaysShow: true });
        const archivedCount = sessions.archived().length;
        if (archivedCount) items.push({ label: `$(archive) Show archived (${archivedCount})`, action: 'archived', alwaysShow: true });
        pick.placeholder = sessions.list().length ? 'Search conversations' : 'No conversations yet';
      }
      pick.items = items;
      const current = items.find(i => i.id && i.id === sessions.selectedId());
      if (current) pick.activeItems = [current];
    };
    build();
    return await new Promise<string | undefined>(resolve => {
      let chosen: string | undefined;
      pick.onDidTriggerItemButton(({ item, button: pressed }) => {
        if (!item.id) return;
        if (pressed === BOOKMARK || pressed === UNBOOKMARK) sessions.setBookmarked(item.id, pressed === BOOKMARK);
        else if (pressed === ARCHIVE) sessions.setArchived(item.id, true);
        else if (pressed === RESTORE) sessions.setArchived(item.id, false);
        build();
      });
      pick.onDidAccept(() => {
        const item = pick.selectedItems[0];
        if (!item) return;
        if (item.action === 'archived' || item.action === 'back') { showArchived = item.action === 'archived'; pick.value = ''; build(); return; }
        if (item.action === 'continue') { pick.hide(); void vscode.commands.executeCommand('turnhuddle.continueFrom'); return; }
        if (item.id) { if (showArchived) sessions.setArchived(item.id, false); sessions.select(item.id); chosen = item.id; void view.reveal(); pick.hide(); }
      });
      pick.onDidHide(() => { pick.dispose(); resolve(chosen); });
      pick.show();
    });
  });
  register('turnhuddle.restore', (argument?: unknown): boolean => { const id = conversationIdFrom(argument); return !!id && sessions.setArchived(id, false); });
  register('turnhuddle.refreshSessions', async (): Promise<number> => { await loaded; return sessions.load(); });
  register('turnhuddle.revealHistory', async (): Promise<string> => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(historyDir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(historyDir));
    return historyDir;
  });
  /** Always starts a new conversation; the current one stays in the history. */
  register('turnhuddle.start', (options?: unknown): Promise<StartResult> => {
    const o = (options ?? {}) as StartOptions;
    const preset = typeof o.task === 'string' && o.task.trim() ? o.task : undefined;
    const n = seatNames(defaultSeats());
    return round(undefined, preset, o.source, `${n.drafter} ↔ ${n.reviewer}`, 'Task to share with both agents. CLI usage may incur charges.');
  });
  register('turnhuddle.listVendorSessions', (options?: unknown): Promise<VendorSession[]> => vendorSessions(!!(options as { all?: boolean } | undefined)?.all));
  /** Starts a conversation that continues one of the CLIs' own sessions. Claude's session is forked; a Codex thread is continued in place. */
  register('turnhuddle.continueFrom', async (options?: unknown): Promise<StartResult> => {
    const o = (options ?? {}) as ContinueOptions;
    let origin: Origin | undefined = o.provider && o.sessionId ? { provider: o.provider, sessionId: o.sessionId, title: o.title ?? '' } : undefined;
    if (!origin) {
      let all = !!o.all;
      for (;;) {
        const found = await vendorSessions(all);
        const age = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
        type Item = vscode.QuickPickItem & { session?: VendorSession; toggle?: boolean };
        const home = homedir();
        const short = (title: string) => title.length > 72 ? `${title.slice(0, 71).trimEnd()}…` : title;
        const folder = (cwd: string) => !cwd ? '' : cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
        const items: Item[] = found.map(session => ({ label: `$(${session.provider === 'claude' ? 'sparkle' : 'terminal'}) ${short(session.title)}`, detail: [session.provider === 'claude' ? 'Claude Code' : 'Codex', age(session.updatedAt), all ? folder(session.cwd) : '', session.provider === 'claude' ? 'forks the session' : 'continues the thread'].filter(Boolean).join(' · '), session }));
        items.push({ label: all ? '$(folder) Only this folder’s sessions' : '$(folder-library) Show sessions from all folders', toggle: true, alwaysShow: true });
        const picked = await vscode.window.showQuickPick(items, { title: 'Continue from a CLI session', placeHolder: found.length ? 'Pick the Claude Code or Codex session to continue in Turnhuddle (Esc or click outside to close)' : 'No saved CLI sessions found for this folder', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: false });
        if (!picked) return { status: 'skipped', messages: [] };
        if (picked.toggle) { all = !all; continue; }
        origin = { provider: picked.session!.provider, sessionId: picked.session!.id, title: picked.session!.title };
        break;
      }
    }
    const preset = typeof o.message === 'string' && o.message.trim() ? o.message : undefined;
    const from = provider(origin.provider);
    return round(undefined, preset, o.source, `Continue from ${from?.product ?? origin.provider}: ${origin.title || origin.sessionId}`, `First message for both agents. ${from?.name ?? origin.provider} drafts with the context of that session; ${agentName(originSeats(origin.provider).reviewer)} joins as reviewer.`, origin);
  });
  /** Continues the selected conversation (or `id`) with another round; starts a new one when none is selected. */
  register('turnhuddle.reply', (options?: unknown): Promise<StartResult> => {
    const o = (options ?? {}) as ReplyOptions;
    const preset = typeof o.message === 'string' && o.message.trim() ? o.message : undefined;
    const id = o.id ?? sessions.selectedId();
    const n = seatNames(id && sessions.getConversation(id) ? seatsOf(sessions.getConversation(id) as StoredConversation) : defaultSeats());
    if (!id) return round(undefined, preset, o.source, `${n.drafter} ↔ ${n.reviewer}`, 'Task to share with both agents. CLI usage may incur charges.');
    return round(id, preset, o.source, `${n.drafter} ↔ ${n.reviewer}: reply`, 'Follow-up for the current conversation. Both agents see the full history.');
  });
  // ---------- choosing agents ----------
  /** Seats an agent: in the open conversation (from its next round) and for new conversations. */
  const applySeats = async (next: Seats): Promise<void> => {
    const id = sessions.selectedId();
    if (id && !running.has(id) && sessions.getConversation(id)) sessions.setSeats(id, next);
    const config = settings();
    for (const seat of ['drafter', 'reviewer'] as const) if (config.get<string>(seat) !== formatAgentSetting(next[seat])) await config.update(seat, formatAgentSetting(next[seat]), vscode.ConfigurationTarget.Global);
  };
  const currentSeats = (): Seats => seatsShown(sessions.get());
  /** Claude Code-style model picker for one seat: every provider, its models found on this machine, another model by id, and swapping the seats. */
  register('turnhuddle.pickAgent', async (seatArgument?: unknown, choice?: unknown): Promise<AgentSpec | undefined> => {
    const seat: Seat = seatArgument === 'reviewer' ? 'reviewer' : 'drafter';
    const id = sessions.selectedId();
    if (id && running.has(id)) { void vscode.window.showInformationMessage('Wait for the round to finish, or stop it, before changing agents.'); return undefined; }
    const seats = currentSeats();
    const set = async (spec: AgentSpec) => { const next = { ...seats, [seat]: labelled(spec) }; await applySeats(next); return next[seat]; };
    if (typeof choice === 'string') { const spec = parseAgentSetting(choice, seats[seat]); return set(spec); }
    type Item = vscode.QuickPickItem & { spec?: AgentSpec; other?: ProviderId; swap?: boolean; settings?: boolean };
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = seat === 'drafter' ? 'Drafter: proposes and revises' : 'Reviewer: critiques the drafter';
    pick.placeholder = `Choose the agent and model for the ${seat} seat (now ${agentName(seats[seat])})`;
    pick.matchOnDetail = true; pick.matchOnDescription = true; pick.busy = true;
    pick.show();
    const items: Item[] = [];
    for (const pid of PROVIDER_IDS) {
      const def = PROVIDERS[pid];
      const [cli, list] = await Promise.all([findCli(pid), models(pid, true)]);
      items.push({ label: `${def.product}${def.preview ? ' · Preview' : ''}${cli ? '' : ' · not installed'}`, kind: vscode.QuickPickItemKind.Separator });
      for (const m of list) {
        const spec: AgentSpec = m.id ? { provider: pid, model: m.id, label: m.label } : { provider: pid };
        const current = sameAgent(spec, seats[seat]);
        items.push({ label: `${current ? '$(check) ' : ''}${m.id ? `${def.name} · ${m.label}` : def.name}`, description: m.id ? (m.id !== m.label ? m.id : '') : 'default model', detail: cli ? m.detail : `${def.product} CLI not found. ${def.installUrl}`, spec });
      }
      items.push({ label: `$(edit) Other ${def.name} model…`, other: pid });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(arrow-swap) Swap drafter and reviewer', description: `${agentName(seats.reviewer)} drafts, ${agentName(seats.drafter)} reviews`, swap: true }, { label: '$(settings-gear) Effort and other settings…', description: [['claude', 'claudeEffort', 'inherit'], ['codex', 'codexReasoningEffort', 'medium']].map(([p, key, d]) => `${PROVIDERS[p as ProviderId].name} ${settings().get<string>(key, d)}`).join(' · '), settings: true });
    pick.items = items; pick.busy = false;
    const active = items.find(i => i.spec && sameAgent(i.spec, seats[seat]));
    if (active) pick.activeItems = [active];
    const picked = await new Promise<Item | undefined>(resolve => { pick.onDidAccept(() => { resolve(pick.selectedItems[0]); pick.hide(); }); pick.onDidHide(() => resolve(undefined)); });
    pick.dispose();
    if (!picked) return undefined;
    if (picked.settings) { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:turnhuddle.turnhuddle'); return undefined; }
    if (picked.swap) { await applySeats({ drafter: seats.reviewer, reviewer: seats.drafter }); return seats.reviewer; }
    let spec = picked.spec;
    if (picked.other) {
      const model = await vscode.window.showInputBox({ title: `Other ${PROVIDERS[picked.other].name} model`, prompt: `Model id, as you'd pass it to ${PROVIDERS[picked.other].cli} --model`, ignoreFocusOut: true, validateInput: v => /^[\w.:/@-]{1,120}$/.test(v.trim()) ? undefined : 'Letters, digits and . : / @ - _ only.' });
      if (!model) return undefined;
      spec = { provider: picked.other, model: model.trim() };
    }
    if (!spec) return undefined;
    if (!(await findCli(spec.provider as ProviderId))) void vscode.window.showWarningMessage(`${PROVIDERS[spec.provider as ProviderId].product} CLI isn't installed. Install it and sign in before the next round.`, 'How to Install').then(c => { if (c) void vscode.env.openExternal(vscode.Uri.parse(PROVIDERS[spec!.provider as ProviderId].installUrl)); });
    return set(spec);
  });
  register('turnhuddle.pickDrafter', () => vscode.commands.executeCommand('turnhuddle.pickAgent', 'drafter'));
  register('turnhuddle.pickReviewer', () => vscode.commands.executeCommand('turnhuddle.pickAgent', 'reviewer'));
  register('turnhuddle.swapSeats', async (): Promise<Seats> => { const s = currentSeats(); const next = { drafter: s.reviewer, reviewer: s.drafter }; await applySeats(next); return next; });
  // ---------- updates ----------
  // Marketplace installs are also updated by VS Code itself; this covers VSIX installs from GitHub Releases.
  const fetcher = fetch as unknown as Fetcher;
  const current = String(context.extension.packageJSON.version ?? '0.0.0');
  const LAST_CHECK = 'turnhuddle.updates.lastCheck', SKIPPED = 'turnhuddle.updates.skipped';
  const installUpdate = async (check: Extract<UpdateCheck, { status: 'available' }>) => {
    try {
      const file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading Turnhuddle ${check.release.version}…` }, async () => {
        const data = await downloadVsix(check.release, fetcher);
        const dir = vscode.Uri.joinPath(context.globalStorageUri, 'updates');
        await vscode.workspace.fs.createDirectory(dir);
        const target = vscode.Uri.joinPath(dir, check.release.vsixName);
        await vscode.workspace.fs.writeFile(target, data);
        return target;
      });
      await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      output.appendLine(`Installed Turnhuddle ${check.release.version} from ${check.release.url}`);
      const choice = await vscode.window.showInformationMessage(`Turnhuddle ${check.release.version} is installed. Reload the window to start using it.`, 'Reload Window');
      if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output.appendLine(`Update failed: ${text}`);
      const choice = await vscode.window.showErrorMessage(`Couldn't install the Turnhuddle update. ${text}`, 'Open Release Page');
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(check.release.url));
    }
  };
  const offerUpdate = async (check: Extract<UpdateCheck, { status: 'available' }>) => {
    const choice = await vscode.window.showInformationMessage(`Turnhuddle ${check.release.version} is available. You have ${check.current}.`, 'Install Update', "What's New", 'Skip This Version');
    if (choice === 'Install Update') await installUpdate(check);
    else if (choice === "What's New") await vscode.env.openExternal(vscode.Uri.parse(`https://sibinms.github.io/turnhuddle/whats-new/#v${check.release.version}`));
    else if (choice === 'Skip This Version') await context.globalState.update(SKIPPED, check.release.version);
  };
  /** `manual` reports every outcome and ignores a skipped version; automatic checks speak only when there is something to install. */
  const runUpdateCheck = async (manual: boolean): Promise<UpdateCheck> => {
    const check = await checkForUpdate(current, fetcher);
    await context.globalState.update(LAST_CHECK, Date.now());
    if (check.status === 'available' && (manual || context.globalState.get<string>(SKIPPED) !== check.release.version)) void offerUpdate(check);
    else if (manual && check.status === 'current') void vscode.window.showInformationMessage(`Turnhuddle is up to date (${check.current}).`);
    else if (manual && check.status === 'none') void vscode.window.showInformationMessage(`No Turnhuddle releases are published on GitHub yet. You have ${check.current}.`);
    else if (manual && check.status === 'error') void vscode.window.showWarningMessage(`Couldn't check for Turnhuddle updates: ${check.error}`);
    return check;
  };
  register('turnhuddle.checkForUpdates', (options?: unknown): Promise<UpdateCheck> => runUpdateCheck(!(options as { silent?: boolean } | undefined)?.silent));
  if (settings().get<boolean>('checkForUpdates', true) && checkDue(context.globalState.get<number>(LAST_CHECK), Date.now())) {
    const timer = setTimeout(() => { void runUpdateCheck(false); }, 15000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
  return {
    getState: () => sessions.get(),
    onDidChangeState: listener => ({ dispose: sessions.subscribe(listener) }),
    isViewResolved: () => view.resolved,
    isViewVisible: () => view.visible,
    listSessions: () => sessions.summaries(),
    runningIds: () => [...running.keys()],
    historyDir: () => historyDir,
    listVendorSessions: all => vendorSessions(all),
    checkForUpdates: () => runUpdateCheck(false),
    logoSources: () => ({ ...view.logoSources }) as Record<string, string>,
    seats: () => currentSeats(),
    chatViewId: () => chatView().viewId,
    liveSessionCount: () => pool.size(),
    closeLiveSessions: () => pool.closeAll(),
    models: id => models(id, true)
  };
}
export async function deactivate(): Promise<void> {
  for (const controller of running.values()) controller.abort();
  poolRef?.closeAll();
  await sessionsRef?.flush();
}
