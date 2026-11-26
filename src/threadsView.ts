// The Threads list in the activity bar: every conversation, like Claude Code's Sessions view and T3 Code's thread sidebar.
import * as vscode from 'vscode';
import type { SessionManager, StoredConversation } from './sessions';
import { threadGroups, threadRow, ThreadGroup } from './threads';
export const THREADS_VIEW = 'turnhuddle.threads';
type Node = { kind: 'group'; group: ThreadGroup } | { kind: 'thread'; id: string; conversation: StoredConversation };
export class ThreadsView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  showArchived = false;
  private tree: vscode.TreeView<Node> | undefined;
  constructor(private readonly sessions: SessionManager, private readonly isRunning: (id: string) => boolean) {}
  register(context: vscode.ExtensionContext): void {
    this.tree = vscode.window.createTreeView(THREADS_VIEW, { treeDataProvider: this, showCollapseAll: false });
    context.subscriptions.push(this.tree, this.changed, { dispose: this.sessions.onDidChangeList(() => this.refresh()) }, { dispose: this.sessions.subscribe(() => this.refresh()) });
    this.refresh();
  }
  private pending: NodeJS.Timeout | undefined;
  /** Coalesces bursts (streamed text updates the state many times a second). */
  refresh(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.changed.fire(undefined);
      if (this.tree) { const running = [...this.allIds()].filter(this.isRunning).length; this.tree.badge = running ? { value: running, tooltip: `${running} running` } : undefined; }
    }, 250);
  }
  private allIds(): string[] { return [...this.sessions.list(), ...this.sessions.archived()].map(c => c.id); }
  setShowArchived(show: boolean): void { this.showArchived = show; void vscode.commands.executeCommand('setContext', 'turnhuddle.showArchived', show); this.changed.fire(undefined); }
  getChildren(node?: Node): Node[] {
    const groups = threadGroups([...this.sessions.list(), ...this.sessions.archived()], this.isRunning, this.showArchived);
    if (!node) {
      // A single group needs no heading: show its threads directly, like Claude's list.
      if (groups.length === 1 && groups[0].id === 'active') return groups[0].threads.map(c => ({ kind: 'thread', id: c.id, conversation: c }));
      return groups.map(group => ({ kind: 'group', group }));
    }
    return node.kind === 'group' ? node.group.threads.map(c => ({ kind: 'thread', id: c.id, conversation: c })) : [];
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group.label, node.group.id === 'archived' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group.id}`; item.contextValue = `group-${node.group.id}`; item.description = String(node.group.threads.length);
      return item;
    }
    const row = threadRow(node.conversation, this.isRunning(node.id));
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = `thread:${row.id}`; item.description = row.description; item.tooltip = row.tooltip; item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.command = { command: 'turnhuddle.open', title: 'Open', arguments: [row.id] };
    if (this.sessions.selectedId() === row.id) item.description = `${row.description ? `${row.description} · ` : ''}open`;
    return item;
  }
  getParent(): undefined { return undefined; }
}
