// Pure view-model for the Turnhuddle chat panel. No VS Code imports: unit-tested with Node alone.
import type { AgentSpec, Message, Progress, RoundOutcome, Seat, Verdict } from './bridge';
import { agentName, DEFAULT_SEATS, PROVIDERS, provider, seatNames } from './providers';
import { escapeHtml, renderMarkdown } from './markdown';
export { escapeHtml };
export type Status = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
export type FinalStatus = Exclude<Status, 'idle' | 'running'>;
export type Role = Message['role'];
export interface ViewMessage { role: Role; content: string; receivedAt: string; verdict?: Verdict; agent?: AgentSpec; steer?: boolean }
/** Text streamed so far by the agent whose turn is running, plus its latest activity note. Cleared when the message lands. */
export interface PartialMessage { role: Seat; text: string; activity?: string }
/** The CLI session a conversation was continued from (see "Continue from" in the README). */
export interface Origin { provider: string; sessionId: string; title: string }
/** The CLI session each seat keeps for this conversation, so later turns resume instead of replaying. Only valid while the same provider sits there. */
export type AgentSessions = Partial<Record<Seat, { provider: string; id: string }>>;
export type Seats = Record<Seat, AgentSpec>;
/** The conversation shown in the panel. All times are ISO strings. */
export interface ConversationState { title?: string; bookmarked?: boolean; status: Status; task?: string; id?: string; startedAt?: string; roundStartedAt?: string; finishedAt?: string; error?: string; messages: ViewMessage[]; partial?: PartialMessage; origin?: Origin; agentSessions?: AgentSessions; outcome?: RoundOutcome; /** Who sits in each seat for the next (or running) round. */ seats?: Seats }
/** Optional webview URIs for the providers' logos, keyed by provider id (`<id>Dark` for dark themes), read from the user's own
 * vendor extensions or media/logos/. Absent: the provider's initials are shown. */
export type Logos = Partial<Record<string, string>>;
export const ROLE_LABELS: Record<Role, string> = { user: 'You', drafter: 'Drafter', reviewer: 'Reviewer' };
/** The seats of a conversation, falling back to Claude drafting and Codex reviewing (how every conversation before 0.3 ran). */
export function seatsOf(state: ConversationState): Seats { return { drafter: state.seats?.drafter ?? DEFAULT_SEATS.drafter, reviewer: state.seats?.reviewer ?? DEFAULT_SEATS.reviewer }; }
/** Who wrote an agent message: the agent recorded on it, else whoever sits in its seat. */
export function messageAgent(state: ConversationState, message: { role: Seat; agent?: AgentSpec }): AgentSpec { return message.agent ?? seatsOf(state)[message.role]; }
/** Display name of a message's author; the seat is added when both seats would otherwise read the same. */
export function authorName(state: ConversationState, message: { role: Seat; agent?: AgentSpec }): string {
  const name = agentName(messageAgent(state, message));
  const seats = seatsOf(state);
  return agentName(seats.drafter) === agentName(seats.reviewer) && name === agentName(seats[message.role]) ? seatNames(seats)[message.role] : name;
}
export const STATUS_LABELS: Record<Status, string> = { idle: 'Ready', running: 'Running', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed' };
/** Label for the state dot: a completed agreement round says so. */
export function statusLabel(state: ConversationState): string {
  if (state.status === 'completed' && state.outcome?.kind === 'agreed') return 'Agreed';
  if (state.status === 'completed' && state.outcome?.kind === 'limit') return 'No agreement';
  return STATUS_LABELS[state.status];
}
/** Progress words shown while a turn is running. One list, cycled every WORD_SECONDS; extend freely. */
export const THINKING_WORDS = ['Pondering', 'Propagating', 'Coagulating', 'Chasing', 'Percolating', 'Mulling', 'Marinating', 'Ruminating', 'Brewing', 'Noodling', 'Simmering', 'Cogitating', 'Untangling', 'Incubating', 'Deliberating', 'Scheming', 'Weighing', 'Distilling'];
export const WORD_SECONDS = 3;
/** Upper bound on a task typed into the composer or the input box. */
export const MAX_TASK_CHARS = 32000;
/** Characters of the task shown as the conversation title. */
export const TITLE_CHARS = 60;
export function initialState(): ConversationState { return { status: 'idle', messages: [] }; }
export function startConversation(task: string, at: Date = new Date()): ConversationState {
  return { status: 'running', task, startedAt: at.toISOString(), roundStartedAt: at.toISOString(), messages: [] };
}
/** A follow-up round on the same conversation: keeps id, task and messages; clears the previous outcome. */
export function resumeConversation(state: ConversationState, at: Date = new Date()): ConversationState {
  const { finishedAt: _finished, error: _error, partial: _partial, outcome: _outcome, ...rest } = state;
  return { ...rest, status: 'running', roundStartedAt: at.toISOString() };
}
/** Number of rounds, one per user message. */
export function rounds(state: ConversationState): number { return state.messages.filter(m => m.role === 'user' && !m.steer).length; }
export function receiveMessage(state: ConversationState, id: string, message: Message, at: Date = new Date()): ConversationState {
  const { partial: _partial, ...rest } = state;
  return { ...rest, id, messages: [...state.messages, { role: message.role, content: message.content, receivedAt: at.toISOString(), ...(message.verdict ? { verdict: message.verdict } : {}), ...(message.agent ? { agent: message.agent } : {}), ...(message.steer ? { steer: true } : {}) }] };
}
/** Streamed text or an activity note for the running turn. Ignored unless the conversation is running. */
export function receiveProgress(state: ConversationState, role: Seat, progress: Progress): ConversationState {
  if (state.status !== 'running') return state;
  const current = state.partial?.role === role ? state.partial : { role, text: '' };
  const partial: PartialMessage = progress.type === 'delta' ? { ...current, text: current.text + progress.text } : { ...current, activity: progress.text };
  return { ...state, partial };
}
export function finishConversation(state: ConversationState, status: FinalStatus, at: Date = new Date(), error?: string, outcome?: RoundOutcome): ConversationState {
  const { partial: _partial, ...rest } = state;
  return { ...rest, status, finishedAt: at.toISOString(), ...(error ? { error } : {}), ...(outcome ? { outcome } : {}) };
}
/** Minimal observable store so the extension and the webview share one state without VS Code events. */
export class ConversationStore {
  private state = initialState();
  private readonly listeners = new Set<(state: ConversationState) => void>();
  get(): ConversationState { return this.state; }
  set(state: ConversationState): void { this.state = state; for (const listener of [...this.listeners]) listener(state); }
  update(change: (state: ConversationState) => ConversationState): void { this.set(change(this.state)); }
  subscribe(listener: (state: ConversationState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
/** Local wall-clock time, HH:MM. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes()].map(n => String(n).padStart(2, '0')).join(':');
}
export function formatDuration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
/** Short single-line title from the task. */
/** Title for a conversation started with `task`: its first sentence or line, without Markdown, at most TITLE_CHARS, cut at a word. */
export function autoTitle(task: string): string {
  const firstLine = task.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const plain = firstLine.replace(/[`*_#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  const sentence = (plain.match(/^.+?[.?!](?=\s|$)/) ?? [plain])[0];
  if (!sentence) return UNTITLED;
  if (sentence.length <= TITLE_CHARS) return sentence.replace(/[.]$/, '');
  const cut = sentence.slice(0, TITLE_CHARS - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}
export const UNTITLED = 'Untitled';
/** The name shown for a conversation: one the user gave it, else the automatic one, else "Untitled". */
export function conversationTitle(state: ConversationState): string {
  if (state.title?.trim()) return state.title.trim();
  return state.task?.trim() ? autoTitle(state.task) : UNTITLED;
}
/** Agent turns taken so far in the current round. A round starts at `roundStartedAt`; messages from earlier rounds do not count. */
export function turnsInRound(state: ConversationState): number {
  const since = state.roundStartedAt;
  const inRound = since ? state.messages.filter(m => m.receivedAt >= since) : state.messages;
  const lastUser = inRound.map(m => m.role === 'user' && !m.steer).lastIndexOf(true);
  return inRound.slice(lastUser + 1).filter(m => m.role !== 'user').length;
}
/** Index of the running stage (0 drafter, 1 reviewer) or -1 when nothing runs. Agents alternate, so this is the parity of the turn. */
export function currentStage(state: ConversationState): number {
  if (state.status !== 'running') return -1;
  return turnsInRound(state) % 2;
}
/** Which seat the relay is waiting on: the drafter first, then alternating. */
export function nextRole(state: ConversationState): Seat {
  return turnsInRound(state) % 2 === 0 ? 'drafter' : 'reviewer';
}
/** When the pending turn began: the last arrival in this round, else the round start. */
export function pendingSince(state: ConversationState): string | undefined {
  const last = state.messages.length ? state.messages[state.messages.length - 1].receivedAt : undefined;
  const round = state.roundStartedAt ?? state.startedAt;
  if (last && round) return last > round ? last : round;
  return last ?? round;
}
/** Word for a given number of elapsed seconds: cycles through `words` every `WORD_SECONDS`, offset so each turn starts somewhere new. */
export function thinkingWord(elapsedSeconds: number, words: readonly string[] = THINKING_WORDS, offset = 0): string {
  if (!words.length) return '';
  const step = Math.floor(Math.max(0, elapsedSeconds) / WORD_SECONDS);
  return words[(step + offset) % words.length];
}
/** Whole seconds as "12s" or "1m 5s". Self-contained: its source is embedded in the webview script. */
export function formatSeconds(elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(elapsedSeconds));
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
/** Text of the live indicator next to the agent's name. Self-contained: embedded in the webview script, so it must not reference module scope. */
export function thinkingLabel(word: string, elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(elapsedSeconds));
  const elapsed = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return word + '… ' + elapsed;
}
/** Avatar for you or an agent: the provider's logo when one is available (light and dark variants), else its initials in its colour. */
export function avatar(who: 'user' | AgentSpec, logos: Logos = {}): string {
  if (who === 'user') return '<span class="avatar avatar-user" aria-hidden="true"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="3" fill="currentColor"/><path d="M2.5 14a5.5 5.5 0 0 1 11 0Z" fill="currentColor"/></svg></span>';
  const def = provider(who.provider);
  const id = def?.id ?? 'other';
  const alt = escapeHtml(def?.name ?? who.provider);
  const logo = logos[id]; const dark = logos[`${id}Dark`];
  if (logo && dark && dark !== logo) return `<img class="avatar avatar-${id} logo-light" src="${escapeHtml(logo)}" alt="${alt}"><img class="avatar avatar-${id} logo-dark" src="${escapeHtml(dark)}" alt="${alt}">`;
  if (logo) return `<img class="avatar avatar-${id}" src="${escapeHtml(logo)}" alt="${alt}">`;
  return `<span class="avatar avatar-${id}" aria-hidden="true">${escapeHtml(def?.initials ?? who.provider.slice(0, 2).toUpperCase())}</span>`;
}
const ICONS = {
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  history: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.3l2.2 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  bookmark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10.6l-4-2.6-4 2.6V3a.5.5 0 0 1 .5-.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>',
  bookmarked: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10.6l-4-2.6-4 2.6V3a.5.5 0 0 1 .5-.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  newChat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 0 1 0 11c-.9 0-1.8-.2-2.6-.6L2.5 13.5l.7-2.7A5.5 5.5 0 0 1 8 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/><path d="M8 5.8v4.4M5.8 8h4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
};
/** Title row, laid out like Claude Code's: a state dot, the title, then Bookmark, History and New conversation.
 * The state's name is in the dot's tooltip and read out to screen readers; the conversation ID is in the title's tooltip. */
export function renderHeader(state: ConversationState): string {
  const idle = state.status === 'idle';
  const tooltip = state.id ? `Conversation ${state.id}` : 'No conversation yet';
  const title = idle ? UNTITLED : conversationTitle(state);
  const label = statusLabel(state);
  const from = state.origin ? provider(state.origin.provider)?.name ?? state.origin.provider : '';
  const origin = state.origin && !idle ? `<span class="origin" title="${escapeHtml(`Continued from ${from} session ${state.origin.sessionId}: ${state.origin.title}`)}">from ${escapeHtml(from)}</span>` : '';
  const dot = idle ? '' : `<span class="state" title="${escapeHtml(label)}"><i class="dot" aria-hidden="true"></i><span class="sr">${escapeHtml(label)}</span></span>`;
  const bookmark = `<button class="icon bookmark${state.bookmarked ? ' on' : ''}" type="button" data-command="bookmark" title="${state.bookmarked ? 'Remove bookmark' : 'Bookmark this conversation'}" aria-pressed="${state.bookmarked ? 'true' : 'false'}"${idle ? ' disabled' : ''}>${state.bookmarked ? ICONS.bookmarked : ICONS.bookmark}</button>`;
  const titleEl = idle ? `<span class="title" title="${escapeHtml(tooltip)}">${escapeHtml(title)}</span>` : `<button class="title" type="button" data-command="rename" title="${escapeHtml(`Rename · ${tooltip}`)}">${escapeHtml(title)}</button>`;
  return `<header class="top status-${state.status}${state.outcome ? ` outcome-${state.outcome.kind}` : ''}">${dot}${titleEl}${origin}${bookmark}<button class="icon" type="button" data-command="history" title="Conversation history">${ICONS.history}</button><button class="icon" type="button" data-command="new" title="New conversation"${idle ? ' disabled' : ''}>${ICONS.newChat}</button></header>`;
}
/** Values the static shell needs for its toolbar; sent alongside the HTML on every render. */
export interface RenderMeta { status: Status; stage: number; round: number; turn: number; roundStartedAt?: string; finishedAt?: string; startedAt?: string; outcome?: RoundOutcome }
export function renderMeta(state: ConversationState): RenderMeta {
  return { status: state.status, stage: currentStage(state), round: rounds(state), turn: state.status === 'running' ? turnsInRound(state) + 1 : turnsInRound(state), roundStartedAt: state.roundStartedAt, finishedAt: state.finishedAt, startedAt: state.startedAt, ...(state.outcome ? { outcome: state.outcome } : {}) };
}
/** HTML fragment for the chat area (header, thread, notices). The composer lives in the static page, outside this fragment. */
/** Extra content for the welcome screen. */
export interface WelcomeOptions { /** Show the "What's new in <version>" card for this version. */ whatsNew?: string; /** Seats a new conversation would get (shown on the welcome screen). */ seats?: Seats }
/** One-line tips under the wordmark, one shown per new conversation (chosen in the webview). */
export const TIPS = [
  'One agent drafts, the other reviews, and they keep going until both agree.',
  'Pick who drafts and who reviews, and which model each uses, from the names under the message box.',
  'Bookmark a conversation to keep it at the top of your history.',
  'Reply to a finished round to dig deeper. Both agents see the whole conversation.',
  'Continue a session you started in the Claude Code or Codex CLI from the history.',
  'Click a conversation\u2019s title to rename it.',
  'Set how hard Codex and Claude think in Turnhuddle\u2019s settings.',
  'Any two can sit together: Claude, Codex or Gemini, even the same provider with two different models.'
];
const MARK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" stroke="var(--th-claude)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 3v5h-5" stroke="var(--th-claude)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" stroke="var(--th-codex)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 16H3v5" stroke="var(--th-codex)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The new-conversation screen, laid out like Claude Code's: wordmark, the two agents, a tip, and a dismissible what's-new card. */
export function renderWelcome(logos: Logos = {}, options: WelcomeOptions = {}): string {
  const card = options.whatsNew ? `<section class="whats-new"><header><span>What's new in ${escapeHtml(options.whatsNew)}</span><button class="icon" type="button" data-command="dismiss-whats-new" title="Dismiss">${ICONS.close}</button></header><p>See what changed in this version, with screenshots.</p><a href="https://sibinms.github.io/turnhuddle/whats-new/#v${escapeHtml(options.whatsNew)}">Read the release notes →</a></section>` : '';
  const seats = options.seats ?? DEFAULT_SEATS;
  return `<section class="welcome"><div class="wordmark">${MARK}<span>Turnhuddle</span></div><div class="welcome-marks" title="${escapeHtml(`${agentName(seats.drafter)} drafts, ${agentName(seats.reviewer)} reviews`)}">${avatar(seats.drafter, logos)}<i class="vs">⇄</i>${avatar(seats.reviewer, logos)}</div><p class="tip" data-tips="${escapeHtml(JSON.stringify(TIPS))}">${escapeHtml(TIPS[0])}</p>${card}</section>`;
}
export function renderConversation(state: ConversationState, logos: Logos = {}, options: WelcomeOptions = {}): string {
  if (state.status === 'idle') return `${renderHeader(state)}${renderWelcome(logos, options)}`;
  const running = state.status === 'running';
  const user = (content: string, time: string, steer?: boolean) => `<article class="msg msg-user${steer ? ' steer' : ''}"><div class="msg-meta">${steer ? '<span class="steer-tag" title="Sent while the agents were working">sent mid-round</span>' : ''}<time datetime="${escapeHtml(time)}">${formatTime(time)}</time></div><div class="user-card"><div class="content">${renderMarkdown(content)}</div></div></article>`;
  const verdictTag = (verdict?: Verdict) => verdict ? `<span class="verdict verdict-${verdict}" title="${verdict === 'agree' ? 'Considers the current recommendation final' : 'Wants further changes'}">${verdict === 'agree' ? 'agrees' : 'continues'}</span>` : '';
  const agentClass = (spec: AgentSpec) => `msg msg-agent p-${escapeHtml(provider(spec.provider)?.id ?? 'other')}`;
  const agent = (m: ViewMessage & { role: Seat }, index: number) => `<article class="${agentClass(messageAgent(state, m))} msg-${m.role}" data-index="${index}"><div class="msg-author">${avatar(messageAgent(state, m), logos)}<span class="name" title="${escapeHtml(`${ROLE_LABELS[m.role]}${messageAgent(state, m).model ? ` · model ${messageAgent(state, m).model}` : ''}`)}">${escapeHtml(authorName(state, m))}</span>${verdictTag(m.verdict)}<time datetime="${escapeHtml(m.receivedAt)}">${formatTime(m.receivedAt)}</time><button class="icon copy" type="button" data-command="copy" data-index="${index}" title="Copy message">${ICONS.copy}</button></div><div class="content">${renderMarkdown(m.content)}</div></article>`;
  // Before the first publish event the task is shown from the state; afterwards every message, user replies included, is rendered.
  const list: ViewMessage[] = state.messages.length ? state.messages : state.task ? [{ role: 'user', content: state.task, receivedAt: state.startedAt ?? '' }] : [];
  let round = 0;
  const turns = list.map((m, index) => `${m.role === 'user' && !m.steer && ++round > 1 ? `<div class="round-divider"><span>Round ${round}</span></div>` : ''}${m.role === 'user' ? user(m.content, m.receivedAt, m.steer) : agent(m as ViewMessage & { role: Seat }, index)}`).join('');
  let thinking = '';
  if (running) {
    const role = nextRole(state); const since = pendingSince(state) ?? new Date().toISOString();
    const partial = state.partial?.role === role ? state.partial : undefined;
    const label = `<span class="thinking-label" aria-live="polite"><i class="spark" aria-hidden="true"></i>${escapeHtml(thinkingLabel(thinkingWord(0, THINKING_WORDS, state.messages.length), 0))}</span>`;
    const activity = partial?.activity && !partial.text ? `<p class="activity">${escapeHtml(partial.activity)}…</p>` : '';
    const streamed = partial?.text ? `<div class="content streaming">${renderMarkdown(partial.text)}</div>` : '';
    const spec = seatsOf(state)[role];
    thinking = `<article class="${agentClass(spec)} msg-${role} thinking${streamed ? ' streaming' : ''}" data-role="${escapeHtml(authorName(state, { role }))}" data-since="${escapeHtml(since)}" data-offset="${state.messages.length}"><div class="msg-author">${avatar(spec, logos)}<span class="name">${escapeHtml(authorName(state, { role }))}</span>${label}</div>${activity}${streamed}</article>`;
  }
  const error = state.error ? `<section class="notice notice-${state.status}"><strong>${state.status === 'cancelled' ? 'Stopped' : 'Failed'}</strong><pre>${escapeHtml(state.error)}</pre></section>` : '';
  const duration = state.startedAt && state.finishedAt ? ` · ${formatDuration(state.roundStartedAt ?? state.startedAt, state.finishedAt)}` : '';
  const outcomeText = state.outcome?.kind === 'agreed' ? `Round ${rounds(state)} · both agreed after ${state.outcome.turns} turn${state.outcome.turns === 1 ? '' : 's'}` : state.outcome?.kind === 'limit' ? `Round ${rounds(state)} · no agreement after ${state.outcome.turns} turns (limit reached)` : `Round ${rounds(state)} complete`;
  const done = !running && !state.error && state.status === 'completed' ? `<p class="done${state.outcome ? ` done-${state.outcome.kind}` : ''}">${outcomeText}${duration}</p>` : '';
  return `${renderHeader(state)}<div class="thread">${turns}${thinking}</div>${error}${done}`;
}
/** Full webview document: static chrome (scrollable chat area, composer with toolbar) filled by `renderConversation` via postMessage. */
export function renderPage(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Turnhuddle</title>
<style nonce="${nonce}">
:root { --th-claude: #d97757; --th-codex: #10a37f; --th-border: var(--vscode-widget-border, rgba(128,128,128,0.28)); --th-surface: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); --th-muted: var(--vscode-descriptionForeground, rgba(128,128,128,0.9)); --th-accent: var(--vscode-button-background, #0e639c); --th-accent-fg: var(--vscode-button-foreground, #fff); }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; }
button { font-family: inherit; font-size: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.4; }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 5px; color: var(--th-muted); }
.icon svg { width: 15px; height: 15px; } .icon:hover:not(:disabled) { background: var(--th-surface); color: var(--vscode-foreground); }
#root { flex: 1 1 auto; overflow-y: auto; padding: 0 14px 12px; }
.top { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 9px 0 8px; margin: 0 0 6px; background: var(--vscode-sideBar-background, inherit); border-bottom: 1px solid var(--th-border); }
.top .title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top { gap: 6px; }
.top .state { display: inline-flex; align-items: center; flex: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top .icon { width: 26px; height: 26px; } .top .icon svg { width: 16px; height: 16px; }
.top .bookmark.on { color: var(--vscode-foreground); }
.top .origin { flex: none; padding: 1px 7px; border-radius: 9px; background: var(--th-surface); border: 1px solid var(--th-border); font-size: 0.74em; color: var(--th-muted); white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--th-muted); }
.status-running .dot { background: var(--vscode-progressBar-background, #0e70c0); animation: pulse-dot 1.2s ease-in-out infinite; }
.status-completed .dot { background: var(--vscode-testing-iconPassed, #388a34); } .status-failed .dot { background: var(--vscode-testing-iconFailed, #f14c4c); } .status-cancelled .dot { background: var(--vscode-testing-iconSkipped, #848484); }
.status-completed.outcome-limit .dot { background: var(--vscode-editorWarning-foreground, #cca700); }
.verdict { padding: 0 6px; border-radius: 8px; font-size: 0.78em; font-weight: 500; }
.verdict-agree { background: rgba(56, 138, 52, 0.18); color: var(--vscode-testing-iconPassed, #4cb04a); }
.verdict-continue { background: rgba(204, 167, 0, 0.16); color: var(--vscode-editorWarning-foreground, #cca700); }
.done-agreed { color: var(--vscode-testing-iconPassed, #4cb04a); } .done-limit { color: var(--vscode-editorWarning-foreground, #cca700); }
@keyframes pulse-dot { 50% { opacity: 0.35; } }
.welcome { text-align: center; padding: 28px 10px 20px; display: flex; flex-direction: column; align-items: center; }
.wordmark { display: flex; align-items: center; gap: 8px; font: 500 1.75em/1.1 "Tiempos Text", "Iowan Old Style", Georgia, serif; letter-spacing: -0.01em; color: var(--vscode-foreground); margin: 6px 0 26px; }
.wordmark .mark { width: 26px; height: 26px; }
.welcome-marks { align-items: center; } .welcome-marks .vs { font-style: normal; color: var(--th-muted); font-size: 1.1em; }
.welcome .avatar { width: 40px !important; height: 40px !important; font-size: 15px !important; }
.tip { max-width: 30em; margin: 22px auto 26px !important; font-size: 1.02em; color: var(--th-muted); line-height: 1.55; }
.whats-new { width: 100%; max-width: 420px; text-align: left; border: 1px solid var(--th-border); border-radius: 12px; background: var(--th-surface); overflow: hidden; }
.whats-new header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--th-border); font-weight: 700; color: var(--th-claude); }
.whats-new p { margin: 12px 14px 6px !important; color: var(--vscode-foreground) !important; }
.whats-new a { display: inline-block; margin: 0 14px 14px; color: var(--vscode-textLink-foreground); text-decoration: none; } .whats-new a:hover { text-decoration: underline; }
button.title { all: unset; flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; border-radius: 4px; padding: 1px 3px; margin-left: -3px; }
button.title:hover { background: var(--th-surface); } button.title:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.welcome-marks { display: flex; justify-content: center; gap: 8px; margin-bottom: 12px; }
.welcome h1 { font-size: 1.2em; margin: 0 0 8px; } .welcome p { margin: 0 auto 8px; max-width: 34em; color: var(--th-muted); } .welcome .fine { font-size: 0.85em; opacity: 0.8; }
.thread { display: flex; flex-direction: column; gap: 14px; }
.msg { min-width: 0; }
.msg-meta { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 4px; font-size: 0.8em; color: var(--th-muted); }
.steer-tag { font-style: italic; } .msg-user.steer .user-card { border-style: dashed; }
.user-card { padding: 9px 12px; border-radius: 10px; background: var(--vscode-input-background, var(--th-surface)); border: 1px solid var(--th-border); }
.msg-author { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-size: 0.9em; }
.msg-author .name { font-weight: 600; } .msg-author time { color: var(--th-muted); font-size: 0.9em; }
.msg-author .copy { margin-left: auto; opacity: 0; transition: opacity 0.15s; } .msg:hover .copy, .copy:focus-visible { opacity: 1; }
${Object.values(PROVIDERS).map(p => `.p-${p.id}, .avatar-${p.id} { --agent: ${p.color}; }`).join(' ')} .p-other, .avatar-other { --agent: #8a8a8a; }
.msg-agent .name { color: var(--agent); }
.avatar { flex: none; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; object-fit: contain; }
.welcome .avatar { width: 28px; height: 28px; font-size: 12px; }
.avatar-user { background: var(--th-accent); color: var(--th-accent-fg); } .avatar-user svg { width: 12px; height: 12px; }
span.avatar:not(.avatar-user) { background: var(--agent, #8a8a8a); }
img.avatar { background: transparent; padding: 1px; }
img.logo-dark { display: none; }
body.vscode-dark img.logo-light, body.vscode-high-contrast:not(.vscode-high-contrast-light) img.logo-light { display: none; }
body.vscode-dark img.logo-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) img.logo-dark { display: inline-flex; }
.msg-agent .content { padding-left: 27px; }
.content > :first-child { margin-top: 0; } .content > :last-child { margin-bottom: 0; }
.content p, .content ul, .content ol, .content blockquote, .content table, .content pre { margin: 0 0 10px; }
.content h1, .content h2, .content h3 { margin: 14px 0 6px; font-size: 1.05em; font-weight: 700; } .content h4, .content h5, .content h6 { margin: 10px 0 4px; font-size: 1em; font-weight: 600; }
.content ul, .content ol { padding-left: 22px; } .content li { margin: 3px 0; }
.content blockquote { padding-left: 10px; border-left: 2px solid var(--th-border); color: var(--th-muted); }
.content hr { border: 0; border-top: 1px solid var(--th-border); margin: 10px 0; }
.content a { color: var(--vscode-textLink-foreground); text-decoration: none; } .content a:hover { text-decoration: underline; }
.content code { padding: 1px 5px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.18)); font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
.content pre.code { position: relative; padding: 9px 11px; border-radius: 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.18)); overflow-x: auto; }
.content pre.code code { padding: 0; background: none; white-space: pre; }
.content pre.code[data-lang] { padding-top: 22px; }
.content pre.code[data-lang]::before { content: attr(data-lang); position: absolute; top: 4px; right: 9px; font-size: 0.75em; color: var(--th-muted); }
.content table { border-collapse: collapse; font-size: 0.95em; } .content th, .content td { padding: 4px 9px; border: 1px solid var(--th-border); text-align: left; }
.thinking-label { display: inline-flex; align-items: center; gap: 5px; margin-left: 2px; font-style: italic; color: var(--th-muted); font-size: 0.92em; }
.spark { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse-dot 1s ease-in-out infinite; }
.activity { margin: 0; padding-left: 27px; font-style: italic; color: var(--th-muted); font-size: 0.92em; }
/* The typing cursor sits at the end of the streamed text: after the last paragraph, or inside the last list item, never on a line of its own. */
.content.streaming > :last-child:not(ul):not(ol):not(pre)::after, .content.streaming > :is(ul, ol):last-child > li:last-child::after, .content.streaming > pre:last-child code::after { content: '▍'; opacity: 0.6; animation: blink 1s steps(2) infinite; }
@keyframes blink { to { opacity: 0; } }
.round-divider { display: flex; align-items: center; gap: 10px; margin: 2px 0; font-size: 0.78em; color: var(--th-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.round-divider::before, .round-divider::after { content: ''; flex: 1; border-top: 1px solid var(--th-border); }
.notice { margin-top: 14px; padding: 9px 12px; border-radius: 8px; background: var(--th-surface); border-left: 3px solid var(--vscode-errorForeground, #f48771); font-size: 0.92em; }
.notice-cancelled { border-left-color: var(--vscode-testing-iconSkipped, #848484); }
.notice pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; }
.done { margin: 14px 0 0; text-align: center; font-size: 0.82em; color: var(--th-muted); }
.composer { flex: none; padding: 6px 12px 10px; background: var(--vscode-sideBar-background, inherit); }
.composer-box { display: flex; flex-direction: column; border: 1px solid var(--vscode-input-border, var(--th-border)); border-radius: 12px; background: var(--vscode-input-background); box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
.composer-box:focus-within { border-color: color-mix(in srgb, var(--th-claude) 75%, transparent); }
body[data-status="running"] .composer-box { border-color: var(--vscode-focusBorder, var(--th-accent)); }
textarea { width: 100%; box-sizing: border-box; min-height: 42px; max-height: 200px; padding: 10px 12px 4px; border: 0; outline: 0; resize: none; background: transparent; color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit; line-height: 1.45; }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); } textarea:disabled { opacity: 0.6; }
.composer-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px 8px 10px; min-height: 28px; min-width: 0; }
.composer-bar > * { flex: 0 1 auto; min-width: 0; } .composer-bar .round-btn, .composer-bar .run-status { flex: none; }
/* When the bar is tight the seats keep their room longest: the effort pill and the mode label give way first. */
.composer-bar .relay { flex: 0 1 auto; } .composer-bar .pill { flex: 0 6 auto; min-width: 2.5em; } .composer-bar .mode { flex: 0 3 auto; overflow: hidden; text-overflow: ellipsis; }
.run-status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8em; color: var(--th-muted); white-space: nowrap; }
.run-status .spinner { display: none; width: 10px; height: 10px; border: 2px solid var(--vscode-progressBar-background, #0e70c0); border-top-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; }
body[data-status="running"] .run-status .spinner { display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.relay { display: inline-flex; align-items: center; gap: 3px; margin-left: 2px; padding: 2px 7px; border-radius: 10px; background: var(--th-surface); font-size: 0.76em; color: var(--th-muted); white-space: nowrap; overflow: hidden; }
.relay > i { font-style: normal; opacity: 0.5; }
.relay .seat { padding: 1px 4px; border-radius: 6px; max-width: 16em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; }
.relay .seat:hover:not(:disabled) { background: color-mix(in srgb, var(--th-muted) 18%, transparent); color: var(--vscode-foreground); }
.relay .seat:disabled { opacity: 1; cursor: default; }
.relay .seat i.sw { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: var(--agent, var(--th-muted)); vertical-align: 0; }
.relay .seat[data-active] { color: var(--vscode-foreground); font-weight: 600; }
.relay .turn { margin-left: 4px; opacity: 0.8; } .relay .turn:empty { display: none; }
.relay .seat[data-active]::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 4px; border-radius: 50%; background: var(--vscode-progressBar-background, #0e70c0); vertical-align: 1px; animation: pulse-dot 1s ease-in-out infinite; }
.pill { padding: 2px 8px; border-radius: 10px; background: var(--th-surface); font-size: 0.76em; color: var(--th-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body[data-status="running"] .pill { display: none; }
.pill:hover { color: var(--vscode-foreground); }
.spacer { flex: 1; }
.round-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; }
.mode { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 10px; font-size: 0.82em; color: var(--th-muted); white-space: nowrap; }
.mode:hover { color: var(--vscode-foreground); background: var(--th-surface); }
body[data-status="running"] .mode { display: none; }
.round-btn svg { width: 15px; height: 15px; }
#send { background: color-mix(in srgb, var(--th-claude) 80%, black); color: #fff; } #send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, var(--th-accent)); }
#send:disabled { opacity: 0.35; }
#stop { display: none; background: var(--vscode-button-secondaryBackground, var(--th-surface)); color: var(--vscode-button-secondaryForeground, inherit); }
#stop:hover { background: var(--vscode-button-secondaryHoverBackground, var(--th-surface)); }
body[data-status="running"] #stop { display: inline-flex; } body[data-status="running"] #send { background: var(--vscode-button-secondaryBackground, var(--th-surface)); color: var(--vscode-button-secondaryForeground, inherit); }
.hint { margin: 6px 2px 0; font-size: 0.76em; color: var(--th-muted); opacity: 0.8; }
/* Status shows only while a round runs; the thread already says how the last round ended. The effort is in the seats' tooltips. */
body:not([data-status="running"]) .run-status { display: none; } .composer-bar .pill { display: none; }
@media (max-width: 300px) { .relay { display: none; } } @media (max-width: 520px) { .pill { display: none; } }
</style>
</head>
<body data-status="idle">
<main id="root"></main>
<footer class="composer">
  <div class="composer-box">
    <textarea id="task" rows="1" maxlength="${MAX_TASK_CHARS}" placeholder="Ask Claude and Codex…" aria-label="Message"></textarea>
    <div class="composer-bar">
      <span class="run-status"><i class="spinner" aria-hidden="true"></i><span id="run-text">Ready</span></span>
      <span class="relay" id="relay"><button class="seat p-claude" type="button" data-seat="drafter" data-stage="0" title="Drafter: proposes and revises. Click to choose the agent and model."><i class="sw" aria-hidden="true"></i><span class="seat-name">Claude</span></button><i>⇄</i><button class="seat p-codex" type="button" data-seat="reviewer" data-stage="1" title="Reviewer: critiques the drafter. Click to choose the agent and model."><i class="sw" aria-hidden="true"></i><span class="seat-name">Codex</span></button><span id="turn" class="turn"></span></span>
      <button id="effort" class="pill" type="button" data-command="settings" title="Turnhuddle settings"></button>
      <span class="spacer"></span>
      <button id="mode" class="mode" type="button" data-command="mode" title="How a round ends. Click to switch."></button>
      <button id="stop" class="round-btn" type="button" data-command="cancel" title="Stop the running conversation">${ICONS.stop}</button>
      <button id="send" class="round-btn" type="button" data-command="send" title="Send (Enter · Shift+Enter for a new line)">${ICONS.send}</button>
    </div>
  </div>
</footer>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const task = document.getElementById('task');
  const send = document.getElementById('send');
  const runText = document.getElementById('run-text');
  const effort = document.getElementById('effort');
  const words = ${JSON.stringify(THINKING_WORDS)};
  const wordSeconds = ${WORD_SECONDS};
  const thinkingLabel = ${thinkingLabel.toString()};
  const formatSeconds = ${formatSeconds.toString()};
  let timer; let meta = { status: 'idle' };
  const seconds = iso => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const tick = () => {
    const el = root.querySelector('.thinking');
    if (el) {
      const elapsed = seconds(el.dataset.since);
      const word = words[(Math.floor(elapsed / wordSeconds) + Number(el.dataset.offset || 0)) % words.length];
      el.querySelector('.thinking-label').lastChild.textContent = thinkingLabel(word, elapsed);
    }
    if (meta.status === 'running' && meta.roundStartedAt) runText.textContent = 'Round ' + Math.max(1, meta.round) + ' · ' + formatSeconds(seconds(meta.roundStartedAt));
    else { clearInterval(timer); timer = undefined; }
  };
  const describe = m => {
    if (m.status === 'running') return 'Round ' + Math.max(1, m.round) + ' · 0s';
    if (m.status === 'completed') return (m.outcome && m.outcome.kind === 'agreed' ? 'Agreed' : m.outcome && m.outcome.kind === 'limit' ? 'No agreement' : 'Done') + (m.roundStartedAt && m.finishedAt ? ' in ' + formatSeconds((Date.parse(m.finishedAt) - Date.parse(m.roundStartedAt)) / 1000) : '');
    if (m.status === 'failed') return 'Failed'; if (m.status === 'cancelled') return 'Stopped';
    return 'Ready';
  };
  const grow = () => { task.style.height = 'auto'; task.style.height = Math.min(task.scrollHeight, 200) + 'px'; };
  const submit = () => {
    const text = task.value.trim();
    if (!text) return;
    vscode.postMessage({ command: document.body.dataset.status === 'running' ? 'steer' : 'send', text });
    task.value = ''; grow();
  };
  window.addEventListener('message', event => {
    if (!event.data || event.data.type !== 'render') return;
    const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 40;
    root.innerHTML = event.data.html;
    meta = event.data.meta || { status: event.data.status || 'idle' };
    const status = meta.status;
    document.body.dataset.status = status;
    const running = status === 'running';
    task.disabled = false; send.disabled = false;
    const ask = typeof event.data.ask === 'string' ? event.data.ask : 'Ask Claude and Codex…';
    task.placeholder = status === 'idle' ? ask : running ? 'Steer the agents… (sent into the running turn)' : 'Reply to continue the conversation…';
    if (event.data.seats) for (const button of document.querySelectorAll('#relay .seat')) {
      const seat = event.data.seats[button.dataset.seat];
      if (!seat) continue;
      button.className = 'seat p-' + seat.provider; button.querySelector('.seat-name').textContent = seat.name; button.title = seat.title; button.disabled = running;
    }
    runText.textContent = describe(meta);
    for (const stage of document.querySelectorAll('#relay .seat')) { if (Number(stage.dataset.stage) === meta.stage) stage.setAttribute('data-active', ''); else stage.removeAttribute('data-active'); }
    document.getElementById('turn').textContent = running && meta.turn ? '· turn ' + meta.turn + (event.data.maxTurns ? ' of ≤' + event.data.maxTurns : '') : '';
    const tip = root.querySelector('.tip[data-tips]');
    if (tip) { try { const tips = JSON.parse(tip.dataset.tips); tip.textContent = tips[Math.floor(Math.random() * tips.length)]; } catch (e) { /* keep the first tip */ } }
    const modeBtn = document.getElementById('mode');
    if (typeof event.data.mode === 'string') modeBtn.textContent = event.data.mode === 'fixed' ? '⇉ Fixed round' : '⚡ Until they agree';
    if (typeof event.data.effort === 'string') { effort.textContent = event.data.effort; effort.style.display = event.data.effort ? '' : 'none'; }
    if (running) { tick(); if (!timer) timer = setInterval(tick, 1000); }
    if (atBottom || running) root.scrollTop = root.scrollHeight;
    if (!running && document.activeElement !== task && document.hasFocus()) task.focus();
  });
  task.addEventListener('input', grow);
  task.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
  send.addEventListener('click', submit);
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  effort.addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
  document.getElementById('mode').addEventListener('click', () => vscode.postMessage({ command: 'mode' }));
  for (const button of document.querySelectorAll('#relay .seat')) button.addEventListener('click', () => { if (!button.disabled) vscode.postMessage({ command: 'pickAgent', seat: button.dataset.seat }); });
  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-command]');
    if (!button || button.disabled) return;
    if (button.dataset.command === 'new') vscode.postMessage({ command: 'new' });
    else if (button.dataset.command === 'history') vscode.postMessage({ command: 'history' });
    else if (button.dataset.command === 'bookmark') vscode.postMessage({ command: 'bookmark' });
    else if (button.dataset.command === 'rename') vscode.postMessage({ command: 'rename' });
    else if (button.dataset.command === 'dismiss-whats-new') { button.closest('.whats-new').remove(); vscode.postMessage({ command: 'dismissWhatsNew' }); }
    else if (button.dataset.command === 'copy') vscode.postMessage({ command: 'copy', index: Number(button.dataset.index) });
  });
  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
}
