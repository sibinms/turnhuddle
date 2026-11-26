import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { claudeAdapter, codexAdapter, ContextMode, Conversation, DEFAULT_MAX_TURNS, Effort, Message, relay, RoundMode, run, SessionOptions } from './bridge';
import { ConversationState, conversationTitle, finishConversation, MAX_TASK_CHARS, Origin, receiveMessage, receiveProgress, resumeConversation } from './conversationView';
import { conversationIdFrom, historyEntries, HistoryStore, SessionManager, SessionSummary, StoredConversation, withAgentSession } from './sessions';
import { listVendorSessions, VendorSession } from './vendorSessions';
import { ConversationViewProvider } from './sidebar';
import { checkDue, checkForUpdate, downloadVsix, Fetcher, UpdateCheck } from './updates';
import { Agent, defaultExtensionRoots, locate, Located, loginShellLookup, SOURCE_LABELS } from './cliLocator';
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
}
const running = new Map<string, AbortController>();
let sessionsRef: SessionManager | undefined;
export function activate(context: vscode.ExtensionContext): TurnhuddleApi {
  const output = vscode.window.createOutputChannel('Turnhuddle');
  context.subscriptions.push(output);
  const historyDir = vscode.Uri.joinPath(context.globalStorageUri, 'conversations').fsPath;
  const sessions = new SessionManager(new HistoryStore(historyDir));
  sessionsRef = sessions;
  const loaded = sessions.load().then(count => { if (count) output.appendLine(`Loaded ${count} saved conversation${count === 1 ? '' : 's'} from ${historyDir}`); }, error => output.appendLine(`Could not load saved conversations: ${String(error)}`));
  const view = new ConversationViewProvider(sessions);
  view.register(context);
  const syncRunning = () => { void vscode.commands.executeCommand('setContext', 'turnhuddle.running', !!sessions.selectedId() && running.has(sessions.selectedId() as string)); };
  context.subscriptions.push({ dispose: sessions.subscribe(() => syncRunning()) });
  syncRunning();
  const settings = () => vscode.workspace.getConfiguration('turnhuddle');
  const ask = (title: string, prompt: string) => vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, validateInput: value => value.trim() ? (value.length > MAX_TASK_CHARS ? `Keep it below ${MAX_TASK_CHARS.toLocaleString()} characters.` : undefined) : 'Enter a message.' });
  // ---------- finding the CLIs ----------
  const VENDOR = { claude: { ext: 'anthropic.claude-code', name: 'Claude Code' }, codex: { ext: 'openai.chatgpt', name: 'Codex' } } as const;
  const shellLookup = process.platform === 'win32' ? undefined : loginShellLookup();
  const found = new Map<string, Located>();
  /** The CLI to run for an agent, from the setting or found automatically (cached while the file exists). */
  const findCli = async (agent: Agent): Promise<Located | undefined> => {
    const configured = settings().get<string>(`${agent}Path`, agent);
    const key = `${agent}:${configured}`;
    const cached = found.get(key);
    if (cached && (cached.source === 'setting' || existsSync(cached.path))) return cached;
    const result = await locate(agent, configured, { home: homedir(), platform: process.platform, envPath: process.env.PATH, shellLookup, extensionDirs: { [agent]: vscode.extensions.getExtension(VENDOR[agent].ext)?.extensionPath }, extensionRoots: defaultExtensionRoots(homedir()) });
    if (result) found.set(key, result); else found.delete(key);
    if (result && result.source !== 'setting' && !cached) output.appendLine(`Using ${VENDOR[agent].name} CLI ${SOURCE_LABELS[result.source]}: ${result.path}`);
    return result;
  };
  const missingCliMessage = (agent: Agent) => `Turnhuddle couldn't find the ${VENDOR[agent].name} CLI. Install the ${VENDOR[agent].name} CLI or the ${VENDOR[agent].name} VS Code extension and sign in, or set turnhuddle.${agent}Path to the executable.`;
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
      const [claudeCli, codexCli] = [await findCli('claude'), await findCli('codex')];
      if (!claudeCli || !codexCli) { void reportMissing(!claudeCli ? 'claude' : 'codex'); return { status: 'failed', id: conversationId, messages, error: missingCliMessage(!claudeCli ? 'claude' : 'codex') }; }
      const cwd = existing?.cwd && existsSync(existing.cwd) ? existing.cwd : folder.uri.fsPath;
      const config = settings();
      const controller = new AbortController();
      if (!conversationId) { conversationId = randomUUID(); sessions.create(conversationId, text, cwd, new Date(), origin); }
      else { sessions.update(conversationId, state => resumeConversation(state)); if (existing?.archived) sessions.setArchived(conversationId, false); sessions.select(conversationId); }
      const target: Conversation = { id: conversationId, history: (existing?.messages ?? []).map(m => ({ role: m.role, content: m.content })) };
      const conversationOrigin = origin ?? existing?.origin;
      const thisId = conversationId;
      // A continued conversation keeps each agent's CLI session: the first Claude turn forks the user's session (the original stays untouched),
      // later turns resume the fork; Codex resumes its thread in place. Such agents get only the new messages, not a replay.
      // The other agent's first turn starts a session of its own that later rounds resume as well.
      const sessionFor = (role: 'claude' | 'codex'): (() => SessionOptions | undefined) => () => {
        if (!conversationOrigin) return undefined;
        const current = sessions.getConversation(thisId)?.agentSessions?.[role];
        const onSession = (sessionId: string) => sessions.update(thisId, state => withAgentSession(state, role, sessionId));
        if (!current) return { onSession };
        return { resume: current, fork: role === 'claude' && current === conversationOrigin.sessionId && conversationOrigin.provider === 'claude', onSession };
      };
      const contextFor = (role: 'claude' | 'codex'): ContextMode => conversationOrigin && sessions.getConversation(thisId)?.agentSessions?.[role] ? 'delta' : 'replay';
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
            const result = await relay(target, text, {
              claude: claudeAdapter(claudeCli.path, limits, config.get<Effort>('claudeEffort', 'inherit'), sessionFor('claude')),
              codex: codexAdapter(codexCli.path, limits, config.get<string>('codexReasoningEffort', 'medium'), sessionFor('codex'))
            }, (_id, message) => {
              messages.push(message);
              sessions.update(thisId, state => receiveMessage(state, thisId, message));
              output.appendLine(`\n[${thisId}] ${message.role}\n${message.content}`);
              progress.report({ message: `${message.role} message received` });
            }, (_id, role, update) => {
              sessions.update(thisId, state => receiveProgress(state, role, update));
              if (update.type === 'activity') progress.report({ message: `${role}: ${update.text}` });
            }, { context: { claude: contextFor('claude'), codex: contextFor('codex') }, mode: config.get<RoundMode>('roundMode', 'agreement'), maxTurns: config.get<number>('maxTurnsPerRound', DEFAULT_MAX_TURNS), onTurn: (turn, role) => progress.report({ message: `turn ${turn}: ${role}` }) });
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
      } finally { if (running.get(thisId) === controller) running.delete(thisId); syncRunning(); }
    } catch (error) {
      const text = String(error);
      output.appendLine(`\n${text}`);
      void vscode.window.showErrorMessage(text);
      return { status: 'failed', id: conversationId, messages, error: text };
    }
  };
  const register = (command: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  register('turnhuddle.getState', (): ConversationState => sessions.get());
  register('turnhuddle.listSessions', (): SessionSummary[] => sessions.summaries());
  register('turnhuddle.check', async (): Promise<string[]> => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('Trust this workspace before checking the CLIs.'); return []; }
    output.show(true);
    const lines: string[] = [];
    const report = (line: string) => { lines.push(line); output.appendLine(line); };
    found.clear();
    for (const agent of ['claude', 'codex'] as const) {
      const cli = await findCli(agent);
      if (!cli) { report(`${agent}: not found. ${missingCliMessage(agent)}`); continue; }
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
  register('turnhuddle.archive', (argument?: unknown): boolean => {
    const id = conversationIdFrom(argument) ?? sessions.selectedId();
    if (!id) return false;
    if (running.has(id)) { void vscode.window.showInformationMessage('Stop the running round before archiving.'); return false; }
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
      return [age(c.updatedAt), `${roundCount} round${roundCount === 1 ? '' : 's'}`, state, c.origin ? `from ${c.origin.provider === 'claude' ? 'Claude Code' : 'Codex'}` : ''].filter(Boolean).join(' · ');
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
    return round(undefined, preset, o.source, 'Claude ↔ Codex', 'Task to share with both providers. CLI usage may incur charges.');
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
    return round(undefined, preset, o.source, `Continue from ${origin.provider === 'claude' ? 'Claude Code' : 'Codex'}: ${origin.title || origin.sessionId}`, `First message for both agents. ${origin.provider === 'claude' ? 'Claude' : 'Codex'} keeps the context of that session; the other agent joins as reviewer.`, origin);
  });
  /** Continues the selected conversation (or `id`) with another round; starts a new one when none is selected. */
  register('turnhuddle.reply', (options?: unknown): Promise<StartResult> => {
    const o = (options ?? {}) as ReplyOptions;
    const preset = typeof o.message === 'string' && o.message.trim() ? o.message : undefined;
    const id = o.id ?? sessions.selectedId();
    if (!id) return round(undefined, preset, o.source, 'Claude ↔ Codex', 'Task to share with both providers. CLI usage may incur charges.');
    return round(id, preset, o.source, 'Claude ↔ Codex: reply', 'Follow-up for the current conversation. Both providers see the full history.');
  });
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
    logoSources: () => ({ ...view.logoSources }) as Record<string, string>
  };
}
export async function deactivate(): Promise<void> {
  for (const controller of running.values()) controller.abort();
  await sessionsRef?.flush();
}
