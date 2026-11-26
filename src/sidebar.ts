import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { ConversationState, Logos, renderConversation, renderMeta, renderPage } from './conversationView';
import { defaultExtensionRoots, newestExtensionDir, vendorLogoFiles } from './cliLocator';
const VENDOR_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' } as const;
/** What the panel needs from the session manager: the selected conversation's state and change notifications. */
export interface StateSource { get(): ConversationState; subscribe(listener: (state: ConversationState) => void): () => void }
export const VIEW_ID = 'turnhuddle.conversation';
export const PUSH_INTERVAL_MS = 60;
/** globalState key: the version whose "What's new" card the user dismissed. */
const WHATS_NEW_SEEN = 'turnhuddle.whatsNewSeen';
/** Short description of the effort settings for the composer toolbar. */
export function effortLabel(): string {
  const config = vscode.workspace.getConfiguration('turnhuddle');
  const codex = config.get<string>('codexReasoningEffort', 'medium'); const claude = config.get<string>('claudeEffort', 'inherit');
  return `Codex ${codex}${claude !== 'inherit' ? ` · Claude ${claude}` : ''}`;
}
/** Vendor logos are not bundled. Files named `claude.svg` / `codex.svg` placed here take precedence over the ones read from the vendor extensions. */
export const LOGO_DIR = ['media', 'logos'] as const;
/** Hosts the conversation webview in the Turnhuddle activity-bar container and mirrors the store into it. */
export class ConversationViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private extensionUri: vscode.Uri | undefined;
  private logos: Logos = {};
  private configListener: vscode.Disposable | undefined;
  private context: vscode.ExtensionContext | undefined;
  constructor(private readonly store: StateSource) {}
  get resolved(): boolean { return this.view !== undefined; }
  get visible(): boolean { return this.view?.visible ?? false; }
  /** Logo URIs in use by the current webview, for diagnostics and tests. */
  get logoSources(): Logos { return { ...this.logos }; }
  register(context: vscode.ExtensionContext): void {
    this.context = context;
    this.extensionUri = context.extensionUri;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, this));
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
    view.webview.onDidReceiveMessage((message: { command?: string; text?: unknown; index?: unknown }) => {
      if (message?.command === 'ready') this.pushNow();
      else if (message?.command === 'send') void vscode.commands.executeCommand('turnhuddle.reply', { message: typeof message.text === 'string' ? message.text : undefined, source: 'sidebar' });
      else if (message?.command === 'cancel') void vscode.commands.executeCommand('turnhuddle.cancel');
      else if (message?.command === 'new') void vscode.commands.executeCommand('turnhuddle.clear');
      else if (message?.command === 'history') void vscode.commands.executeCommand('turnhuddle.history');
      else if (message?.command === 'bookmark') void vscode.commands.executeCommand('turnhuddle.toggleBookmark');
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
    else await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
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
    void this.view.webview.postMessage({ type: 'render', status: state.status, meta: renderMeta(state), effort: effortLabel(), mode: config.get<string>('roundMode', 'agreement'), maxTurns: config.get<string>('roundMode', 'agreement') === 'agreement' ? config.get<number>('maxTurnsPerRound', 10) : 3, html: renderConversation(state, this.logos, { whatsNew }) });
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
    vscode.window.setStatusBarMessage(`Turnhuddle: copied ${message.role === 'user' ? 'your message' : `${message.role}'s message`}`, 2500);
  }
}
