// What the Threads list shows: groups, row text and icons. No VS Code imports, so it is unit-tested with Node alone.
import { conversationTitle, rounds, seatsOf } from './conversationView';
import { agentName } from './providers';
import type { StoredConversation } from './sessions';

/** VS Code gained the secondary side bar contribution point in 1.106; Claude Code uses the same cut-off. */
export function supportsSecondarySidebar(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(n => Number.parseInt(n, 10) || 0);
  return major > 1 || (major === 1 && minor >= 106);
}
export type ThreadState = 'running' | 'agreed' | 'no-agreement' | 'done' | 'stopped' | 'failed';
export function threadState(c: StoredConversation, running: boolean): ThreadState {
  if (running) return 'running';
  if (c.status === 'completed') return c.outcome?.kind === 'agreed' ? 'agreed' : c.outcome?.kind === 'limit' ? 'no-agreement' : 'done';
  if (c.status === 'cancelled') return 'stopped';
  if (c.status === 'failed') return 'failed';
  return 'done';
}
/** Codicon per state, like the badges on T3's thread rows. */
export const STATE_ICONS: Record<ThreadState, string> = { running: 'loading~spin', agreed: 'pass', 'no-agreement': 'warning', done: 'comment-discussion', stopped: 'debug-stop', failed: 'error' };
export const STATE_LABELS: Record<ThreadState, string> = { running: 'Running', agreed: 'Agreed', 'no-agreement': 'No agreement', done: 'Done', stopped: 'Stopped', failed: 'Failed' };
/** "just now", "12m", "3h", "2d", then the date. */
export function shortAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 14) return `${Math.round(minutes / 1440)}d`;
  return new Date(iso).toLocaleDateString();
}
export interface ThreadRow { id: string; label: string; description: string; tooltip: string; icon: string; contextValue: string }
export function threadRow(c: StoredConversation, running: boolean, now: number = Date.now()): ThreadRow {
  const state = threadState(c, running);
  const seats = seatsOf(c);
  const pair = `${agentName(seats.drafter)} ⇄ ${agentName(seats.reviewer)}`;
  const n = rounds(c);
  const flags = [c.bookmarked ? 'bookmarked' : '', running ? 'running' : ''].filter(Boolean).join(' ');
  return {
    id: c.id,
    label: conversationTitle(c),
    description: [state === 'done' || state === 'running' ? '' : STATE_LABELS[state], shortAge(c.updatedAt, now)].filter(Boolean).join(' · '),
    tooltip: [conversationTitle(c), `${STATE_LABELS[state]} · ${n} round${n === 1 ? '' : 's'}`, pair, c.origin ? `Continued from a ${c.origin.provider} session` : '', c.cwd].filter(Boolean).join('\n'),
    icon: c.bookmarked && state !== 'running' ? 'bookmark' : STATE_ICONS[state],
    contextValue: `thread-${c.archived ? 'archived' : 'live'}${flags ? ` ${flags}` : ''}`
  };
}
export interface ThreadGroup { id: 'bookmarked' | 'active' | 'archived'; label: string; threads: StoredConversation[] }
/** Bookmarked, then everything else newest first (running ones on top), then Archived when asked for. Empty groups are left out. */
export function threadGroups(conversations: StoredConversation[], isRunning: (id: string) => boolean, showArchived = false): ThreadGroup[] {
  const newest = (a: StoredConversation, b: StoredConversation) => Number(isRunning(b.id)) - Number(isRunning(a.id)) || b.updatedAt.localeCompare(a.updatedAt);
  const live = conversations.filter(c => !c.archived);
  const groups: ThreadGroup[] = [
    { id: 'bookmarked', label: 'Bookmarked', threads: live.filter(c => c.bookmarked).sort(newest) },
    { id: 'active', label: 'Recent', threads: live.filter(c => !c.bookmarked).sort(newest) }
  ];
  if (showArchived) groups.push({ id: 'archived', label: 'Archived', threads: conversations.filter(c => c.archived).sort(newest) });
  return groups.filter(g => g.threads.length);
}
