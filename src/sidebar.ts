import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { authorName, ConversationState, Logos, renderConversation, renderMeta, renderPage, Seats } from './conversationView';
import { agentName, provider, seatNames } from './providers';
import { defaultExtensionRoots, newestExtensionDir, vendorLogoFiles } from './cliLocator';
const VENDOR_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' } as const;
/** What the panel needs from the session manager: the selected conversation's state and change notifications. */
export interface StateSource { get(): ConversationState; subscribe(listener: (state: ConversationState) => void): () => void }
/** The chat lives in the secondary side bar where VS Code has one (1.106+), like Claude Code's; otherwise in its own activity-bar container. */
export const CHAT_VIEW_SECONDARY = 'turnhuddle.chatSecondary';
export const CHAT_VIEW_PRIMARY = 'turnhuddle.chat';
export const PUSH_INTERVAL_MS = 60;
/** globalState key: the version whose "What's new" card the user dismissed. */
const WHATS_NEW_SEEN = 'turnhuddle.whatsNewSeen';
/** Short description of the effort settings that apply to the seated agents, for the composer toolbar. Empty when none is set. */
export function effortLabel(seats: Seats): string {
  const config = vscode.workspace.getConfiguration('turnhuddle');
  const parts: string[] = [];
  for (const id of new Set([seats.drafter.provider, seats.reviewer.provider])) {
    const def = provider(id);
    if (!def?.effortSetting) continue;
    const value = config.get<string>(def.effortSetting, id === 'codex' ? 'medium' : 'inherit');
    if (value !== 'inherit') parts.push(`${def.name} ${value}`);
  }
  return parts.join(' · ');
}
/** Composer placeholder for a new conversation: "Ask Claude and Codex…", or "Ask Claude…" when one provider takes both seats. */
export function askPlaceholder(seats: Seats): string {
  const names = [...new Set([seats.drafter, seats.reviewer].map(s => provider(s.provider)?.name ?? s.provider))];
  return `Ask ${names.join(' and ')}…`;
}
export interface ViewOptions { /** Who sits in the seats for the given state (the open conversation's, or the defaults for a new one). */ seats(state: ConversationState): Seats }
/** Vendor logos are not bundled. Files named `claude.svg` / `codex.svg` placed here take precedence over the ones read from the vendor extensions. */
export const LOGO_DIR = ['media', 'logos'] as const;
/** Hosts the conversation webview in the Turnhuddle activity-bar container and mirrors the store into it. */
export class ConversationViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private extensionUri: vscode.Uri | undefined;
  private logos: Logos = {};
  private configListener: vscode.Disposable | undefined;
  private context: vscode.ExtensionContext | undefined;
  constructor(private readonly store: StateSource, private readonly options: ViewOptions, readonly viewId: string = CHAT_VIEW_SECONDARY) {}
  get resolved(): boolean { return this.view !== undefined; }
  get visible(): boolean { return this.view?.visible ?? false; }
  /** Logo URIs in use by the current webview, for diagnostics and tests. */
  get logoSources(): Logos { return { ...this.logos }; }
  register(context: vscode.ExtensionContext): void {
    this.context = context;
    this.extensionUri = context.extensionUri;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(this.viewId, this, { webviewOptions: { retainContextWhenHidden: false } }));
    context.subscriptions.push({ dispose: this.store.subscribe(() => this.push()) });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Logos: files the user put in media/logos/ win; otherwise the marks shipped with the user's own Claude Code and Codex
    // extensions are shown from where they are installed. Turnhuddle itself bundles no vendor logos.
    const logoRoot = this.extensionUri && vscode.Uri.joinPath(this.extensionUri, ...LOGO_DIR);
    const roots: vscode.Uri[] = logoRoot ? [logoRoot] : [];
    const files: Partial<Record<'claude' | 'codex', { light: string; dark: string }>> = {};
    for (const agent of ['claude', 'codex'] as const) {
      const own = logoRoot && vscode.Uri.joinPath(logoRoot, `${agent}.svg`).fsPath;
      if (own && existsSync(own)) { files[agent] = { light: own, dark: own }; continue; }
      if (!vscode.workspace.getConfiguration('turnhuddle').get<boolean>('vendorLogos', true)) continue;
      const dir = vscode.extensions.getExtension(VENDOR_EXTENSIONS[agent])?.extensionPath ?? newestExtensionDir(agent, defaultExtensionRoots(homedir()));
      const found = dir ? vendorLogoFiles(agent, dir) : undefined;
      if (found && dir) { files[agent] = found; roots.push(vscode.Uri.joinPath(vscode.Uri.file(dir), 'resources')); }
    }
    view.webview.options = { enableScripts: true, localResourceRoots: roots };
    this.logos = {};
    for (const agent of ['claude', 'codex'] as const) {
      const f = files[agent];
      if (!f) continue;
      this.logos[agent] = view.webview.asWebviewUri(vscode.Uri.file(f.light)).toString();
      this.logos[`${agent}Dark`] = view.webview.asWebviewUri(vscode.Uri.file(f.dark)).toString();
    }
    view.webview.html = renderPage(randomBytes(16).toString('hex'), view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: { command?: string; text?: unknown; index?: unknown; seat?: unknown }) => {
      if (message?.command === 'ready') this.pushNow();
      else if (message?.command === 'send') void vscode.commands.executeCommand('turnhuddle.reply', { message: typeof message.text === 'string' ? message.text : undefined, source: 'sidebar' });
      else if (message?.command === 'cancel') void vscode.commands.executeCommand('turnhuddle.cancel');
      else if (message?.command === 'new') void vscode.commands.executeCommand('turnhuddle.clear');
      else if (message?.command === 'history') void vscode.commands.executeCommand('turnhuddle.history');
      else if (message?.command === 'bookmark') void vscode.commands.executeCommand('turnhuddle.toggleBookmark');
      else if (message?.command === 'pickAgent') void vscode.commands.executeCommand('turnhuddle.pickAgent', message.seat === 'reviewer' ? 'reviewer' : 'drafter');
      else if (message?.command === 'rename') void vscode.commands.executeCommand('turnhuddle.rename');
      else if (message?.command === 'mode') { const config = vscode.workspace.getConfiguration('turnhuddle'); void config.update('roundMode', config.get<string>('roundMode', 'agreement') === 'fixed' ? 'agreement' : 'fixed', vscode.ConfigurationTarget.Global); }
      else if (message?.command === 'dismissWhatsNew') void this.context?.globalState.update(WHATS_NEW_SEEN, this.version());
      else if (message?.command === 'settings') void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:turnhuddle.turnhuddle');
      else if (message?.command === 'copy') void this.copy(typeof message.index === 'number' ? message.index : -1);
    });
    this.configListener?.dispose();
    this.configListener = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('turnhuddle')) this.pushNow(); });
    view.onDidChangeVisibility(() => { if (view.visible) this.pushNow(); });
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.configListener?.dispose(); this.configListener = undefined; } });
  }
  /** Brings the view into the sidebar without taking focus from the editor. */
  async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${this.viewId}.focus`);
  }
  private pending: NodeJS.Timeout | undefined;
  /** Re-renders at most every PUSH_INTERVAL_MS so a burst of streamed deltas does not flood the webview. */
  private push(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = undefined; this.pushNow(); }, PUSH_INTERVAL_MS);
  }
  private pushNow(): void {
    if (!this.view || !this.view.visible) return;
    const state = this.store.get();
    const config = vscode.workspace.getConfiguration('turnhuddle');
    const version = this.version();
    const whatsNew = version && this.context?.globalState.get<string>(WHATS_NEW_SEEN) !== version ? version : undefined;
    const seats = this.options.seats(state);
    const names = seatNames(seats);
    const effortOf = (id: string) => { const key = provider(id)?.effortSetting; const value = key ? config.get<string>(key, id === 'codex' ? 'medium' : 'inherit') : undefined; return value && value !== 'inherit' ? ` Effort: ${value}.` : ''; };
    const seat = (s: 'drafter' | 'reviewer') => ({ name: names[s], provider: provider(seats[s].provider)?.id ?? 'other', title: `${s === 'drafter' ? 'Drafter: proposes and revises' : 'Reviewer: critiques the drafter'}. ${agentName(seats[s])}${seats[s].model ? ` (${seats[s].model})` : ''}.${effortOf(seats[s].provider)}${state.status === 'running' ? '' : ' Click to choose the agent and model.'}` });
    void this.view.webview.postMessage({ type: 'render', status: state.status, meta: renderMeta(state), seats: { drafter: seat('drafter'), reviewer: seat('reviewer') }, ask: askPlaceholder(seats), effort: effortLabel(seats), mode: config.get<string>('roundMode', 'agreement'), maxTurns: config.get<string>('roundMode', 'agreement') === 'agreement' ? config.get<number>('maxTurnsPerRound', 10) : 3, html: renderConversation(state, this.logos, { whatsNew, seats }) });
  }
  private version(): string | undefined {
    const v = this.context?.extension.packageJSON?.version;
    return typeof v === 'string' ? v : undefined;
  }
  /** Copies a landed message to the clipboard (the webview may lack clipboard access). */
  private async copy(index: number): Promise<void> {
    const message = this.store.get().messages[index];
    if (!message) return;
    await vscode.env.clipboard.writeText(message.content);
    const state = this.store.get();
    vscode.window.setStatusBarMessage(`Turnhuddle: copied ${message.role === 'user' ? 'your message' : `${authorName(state, { role: message.role, agent: message.agent })}'s message`}`, 2500);
  }
}
