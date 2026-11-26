import * as vscode from 'vscode';
import { SessionManager, StoredConversation } from './sessions';
export const SESSIONS_VIEW_ID = 'turnhuddle.sessions';
type Node = { kind: 'group'; group: 'recent' | 'archived' } | { kind: 'conversation'; conversation: StoredConversation };
const STATUS_ICONS: Record<StoredConversation['status'], string> = { idle: 'circle-outline', running: 'loading~spin', completed: 'check', cancelled: 'circle-slash', failed: 'error' };
function relative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60); if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
/** Native list of this window's conversations above the chat panel. Click opens one; archived ones sit in a collapsed group. */
export class SessionsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly sessions: SessionManager, private readonly running: () => Set<string>) {}
  register(context: vscode.ExtensionContext): vscode.TreeView<Node> {
    const view = vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: this, showCollapseAll: false });
    context.subscriptions.push(view, { dispose: this.sessions.onDidChangeList(() => this.refresh()) });
    return view;
  }
  refresh(): void { this.emitter.fire(undefined); }
  getChildren(node?: Node): Node[] {
    if (!node) {
      const recent = this.sessions.list().map(conversation => ({ kind: 'conversation', conversation }) as Node);
      return this.sessions.archived().length ? [...recent, { kind: 'group', group: 'archived' }] : recent;
    }
    if (node.kind === 'group' && node.group === 'archived') return this.sessions.archived().map(conversation => ({ kind: 'conversation', conversation }) as Node);
    return [];
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(`Archived (safe to delete) · ${this.sessions.archived().length}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'turnhuddle.archivedGroup'; item.iconPath = new vscode.ThemeIcon('archive');
      item.tooltip = 'Archived conversations stay on disk. Use "Reveal History Folder" to review and delete files yourself.';
      return item;
    }
    const c = node.conversation;
    const title = c.task.replace(/\s+/g, ' ').trim();
    const item = new vscode.TreeItem(title.length > 60 ? `${title.slice(0, 59)}…` : title || 'Untitled', vscode.TreeItemCollapsibleState.None);
    const running = this.running().has(c.id);
    const status = running ? 'running' : c.status;
    const selected = this.sessions.selectedId() === c.id;
    item.id = c.id;
    item.description = `${c.bookmarked ? '🔖 ' : ''}${status === 'running' ? 'running' : status}${c.messages.length ? ` · ${c.messages.filter(m => m.role === 'user').length} round${c.messages.filter(m => m.role === 'user').length === 1 ? '' : 's'}` : ''} · ${relative(c.updatedAt)}${selected ? ' · open' : ''}`;
    item.iconPath = new vscode.ThemeIcon(STATUS_ICONS[status], status === 'failed' ? new vscode.ThemeColor('testing.iconFailed') : status === 'completed' ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    item.tooltip = new vscode.MarkdownString(`**${title || 'Untitled'}**\n\n${status} · ${c.messages.length} messages\n\nStarted ${new Date(c.createdAt).toLocaleString()}\n\nFolder: ${c.cwd || '(none)'}\n\nID: \`${c.id}\``);
    item.contextValue = c.archived ? 'turnhuddle.archived' : running ? 'turnhuddle.running' : 'turnhuddle.conversation';
    item.command = { command: 'turnhuddle.open', title: 'Open conversation', arguments: [c.id] };
    return item;
  }
  getParent(): undefined { return undefined; }
}
/** Conversation id from a tree node, a command argument string, or nothing. */
export function conversationIdFrom(argument: unknown): string | undefined {
  if (typeof argument === 'string') return argument;
  if (argument && typeof argument === 'object') {
    const node = argument as Partial<Node> & { id?: unknown };
    if (node.kind === 'conversation' && node.conversation) return node.conversation.id;
    if (typeof node.id === 'string') return node.id;
  }
  return undefined;
}
