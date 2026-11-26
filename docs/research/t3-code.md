# How T3 Code works, and what it means for Turnhuddle

Research notes, 2026-11-26. Sources: <https://t3.codes>, the MIT-licensed source at
`github.com/pingdotgg/t3code` (commit `3fa136a5`), its `docs/`, and the installed Claude Code
(2.1.332) and Codex (26.1120) VS Code extensions.

## What T3 Code is

A standalone app (desktop, web, phone) that controls coding agents you're already signed in to:
Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Kiro, Pi and any ACP agent. One local
server owns the agent processes, Git, terminals and state; every client is a view onto it.

## How it drives the agents

| Agent | How T3 talks to it | What that gives it |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` `query()`: one long-lived session per thread | streaming, `setModel` and `setPermissionMode` mid-thread, `interrupt`, `canUseTool` approvals, `resume` / `forkSession` |
| Codex | `codex app-server -c thread_unload_delay_secs=0`: JSON-RPC over stdio (`thread/start`, `turn/start`, steer, approvals) | the same: persistent threads, mid-turn steering, approvals, model per turn |
| Everyone else | **ACP** (Agent Client Protocol), strictly per spec | any ACP agent works without a custom adapter; Gemini CLI speaks ACP |

Rules from their internals docs worth copying:

- Orchestration reads **capabilities**, never provider names (fork, rollback, steering, subagents).
- **Never fake a permission mode**; expose only what the provider enforces.
- `"Default"` is a sentinel, never sent as a model id.
- Gate Stop on the provider's "turn started" signal.
- Test adapters with **recorded real provider output**.

## The user-facing model

- **Thread** = one task, one conversation, one agent at a time. The composer shows a single model
  chip ("Opus 5.5 Medium") plus permission mode.
- **Switch model mid-thread**: the new provider gets a *portable handoff*, a budgeted summary of
  the history (about 16k tokens).
- **Agents call agents**: a `delegate_task` tool lets Claude hand work to Codex (any model,
  worktree or machine). `@opus` in a prompt picks the delegate.
- **Thread list** on the left: Pinned / Active / Working / Settled, each row with project, branch,
  age and a status badge (*Approval*, *Done*). Right panel: branch, Commit/push/PR, changes.
- Each thread can have its own **worktree**. Approvals and questions appear inline. Steer or queue
  while the agent works.

## How Claude Code lays out VS Code (what "like Claude" means)

- The chat is **one webview view** whose name equals its container's title, so VS Code shows one
  header ("CLAUDE CODE"), not "CONTAINER: VIEW".
- On VS Code **1.106+** the chat lives in the **secondary side bar** (right). Older versions use the
  activity bar. A `when` context key set at activation switches between them.
- A separate **Sessions** list sits in the activity bar (left). It is a different container from
  the chat, not a section stacked above it.
- Entry points: an editor-title button "Open", `cmd+escape` to focus, and "Open in New Tab"
  (the chat as an editor panel).

## Where Turnhuddle differs today

1. **Spawns a new CLI process per turn and replays the whole history.** That's slower, there's no
   steering, no approvals, and no tool activity for Claude. T3 keeps one session per agent per thread.
2. **Two agents debate until both agree.** T3 has no such mode. Its nearest features are model
   switching and `delegate_task`. This is Turnhuddle's distinct idea and is worth keeping.
3. **Sidebar** reuses the ids from 0.2.1, so VS Code still shows the cached "Conversations" section
   in old workspaces. It also sits in the primary side bar with a two-part header.

## Why the old "Conversations" section still shows

VS Code stores the layout per workspace and globally (`state.vscdb`,
`workbench.view.extension.turnhuddle.state`). 0.2.1 registered two views, `turnhuddle.sessions` and
`turnhuddle.conversation`. 0.2.7 kept the container id `turnhuddle`, so that cached layout keeps
applying. Moving to new container and view ids (as the secondary-sidebar move needs anyway) leaves
it behind.

## Options

- **A. Keep Turnhuddle a VS Code extension and adopt T3's architecture.** Persistent sessions
  (Claude Agent SDK, `codex app-server`, ACP for Gemini and the rest), chat in the secondary side
  bar, a thread list, and one model chip with mid-thread switching. *Debate until agreed* stays as a
  mode, plus a T3-style "hand this to another agent".
- **B. Fork T3 Code** (MIT) as a standalone app and add *debate until agreed*. Their trademark
  policy requires our own name and branding, and a clear statement that it's unofficial.
- **C. Layout only.** Move the chat to the secondary side bar and fix the header and ids, but keep
  the per-turn CLI engine.
