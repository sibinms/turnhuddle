# Changelog

All notable changes to Turnhuddle are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.3.1 — 2026-11-26

### Changed
- Rounds are quiet however they start, including **Continue from Claude/Codex** and the Command Palette: no progress pop-up, no "cancelled" or error pop-ups, and the Output panel no longer opens. Progress, Stop and errors show in the chat; the Output channel is still written to.

### Fixed
- A window that was open when Turnhuddle updated from 0.2 kept the old layout, and its **Chat** pane loaded forever. It now says to reload the window and has a **Reload Window** button.

## 0.3.0 — 2026-11-26

### Added
- **Live agent sessions** (`turnhuddle.engine: "live"`, default), the way T3 Code runs agents: one long-lived session per thread and seat. Codex via `codex app-server`, Claude via the bundled Claude Agent SDK pointed at your own CLI, Gemini and other agents via ACP. Sessions are resumed after a reload, Stop interrupts a turn and keeps the session, and idle sessions close after 20 minutes.
- **Steering:** type while a round runs. Claude and Codex take the message into the running turn; others get it before their next turn. It's shown as *sent mid-round*.
- The chat moved to VS Code's **secondary side bar** (1.106+) as a single "Turnhuddle" panel, like Claude Code; older VS Code keeps an activity-bar container. New view ids, so 0.2's cached "Conversations" section disappears.
- **Threads** list in the activity bar: bookmarked, recent (running first) and, on demand, archived, with Bookmark/Archive/Rename on each row. Editor-title button and **Open Chat** command.
- Each seat keeps its own CLI session for the whole thread (`claude --resume`, `codex exec resume`); later turns send only new messages (`turnhuddle.keepAgentSessions`).
- Two seats, **drafter** and **reviewer**, each any provider and model. Click a seat under the message box for a picker that lists the models found on this machine (Codex's model cache, Claude's aliases and recently used models, Gemini's), accepts any other model id, and swaps the seats. Saved per conversation and as `turnhuddle.drafter` / `turnhuddle.reviewer` for new ones.
- **Gemini CLI** as a provider, in preview (`turnhuddle.geminiPath`).
- Commands: Choose the Drafter's / Reviewer's Agent and Model, Swap Drafter and Reviewer.
- A provider registry (`src/providers.ts`): adding a CLI is one entry plus its model list.

### Changed
- Messages record the provider and model that wrote them; names show the model.
- Prompts name each agent and seat and pass the conversation as `{from, content, verdict}`.
- Composer: seats, mode and Send; the status shows only while running; effort moved to the seat tooltips and the picker.
- "Start Claude ↔ Codex Conversation" is now "Start Conversation".

### Migration
- Conversations saved by 0.2.x load with Claude as drafter and Codex as reviewer.

## 0.2.7 — 2026-11-26

### Added
- Every conversation has a name: **Untitled** until the first message, then its first line. Click the header title (or run **Turnhuddle: Rename Conversation**) to rename; an empty name restores the automatic one.

### Changed
- The new-chat screen looks like Claude Code's: wordmark, both agents, a tip and a dismissible **What's new** card after updates.
- Composer: *Ask Claude and Codex…*, a mode chip (**Until they agree** / **Fixed round**) that switches `turnhuddle.roundMode`, a square send button, no hint line.

## 0.2.6 — 2026-11-26

### Fixed
- A progress sound looped while an agent was thinking when VS Code's accessibility signals were on. Chat-started rounds no longer show a VS Code progress indicator.

### Changed
- A single chat window, like Claude Code: the Conversations view is removed and past conversations live in the history (the clock), with Bookmark and Archive buttons on each row and Show archived to restore.
- The view title bar no longer repeats the New and Stop actions.

## 0.2.5 — 2026-11-26

### Fixed
- "output exceeded the configured limit of 1048576 bytes" when Claude read large files: `turnhuddle.maxOutputBytes` now limits the reply, not the CLI's whole event stream, which has its own 64 MB cap.

### Changed
- Rounds started from the chat show progress as the view's progress bar instead of a notification, so there are no popups or notification sounds while the agents work. Cancelled and failed rounds are reported in the chat only. Command Palette starts keep the popup.

## 0.2.4 — 2026-11-26

### Added
- A chat header like Claude Code's: **Bookmark**, **History** and **New conversation**. History is a searchable list with bookmarked conversations first and *Continue from a Claude Code or Codex session…* at the end. Bookmarks are saved with the conversation.
- Claude and Codex logos next to their messages, read from the Claude Code and Codex VS Code extensions installed on your machine (none are bundled). The OpenAI blossom follows light and dark themes. `turnhuddle.vendorLogos` turns this off; without those extensions, initials are shown as before.

### Changed
- Chat is the first view in the Turnhuddle sidebar; Conversations is below it, folded.
- The state label in the header is now a coloured dot before the title.

## 0.2.3 — 2026-11-26

### Fixed
- "Cannot run claude: spawn claude ENOENT" when the CLIs aren't on PATH. With the path settings left at their defaults, Turnhuddle now finds the Claude Code and Codex CLIs on PATH, in common install folders, in the login shell's PATH, or bundled with the Claude Code and Codex VS Code extensions.

### Changed
- **Check CLI Installations** reports where each CLI was found.
- A missing CLI is reported before a conversation starts, with **Open Settings** and **Check Again**.

## 0.2.2 — 2026-11-26

### Fixed
- Session picker titles show what you typed, not IDE context or CLI-added blocks, and no Markdown symbols or stray backslashes.
- The session picker closes when you click outside it.
- The Conversations view's empty message showed a literal `\n`.

### Changed
- Session picker rows show the tool and age on one line under the title.
- The README, and so the Marketplace page, now shows screenshots and the full feature overview.

## 0.2.1 — 2026-11-26

### Added
- **Check for updates**: once a day Turnhuddle asks GitHub for the latest release and offers to install a newer one, verifying the VSIX checksum first. **Turnhuddle: Check for Updates** runs it on demand; `turnhuddle.checkForUpdates` turns the daily check off.
- Releases are published automatically from GitHub with Marketplace trusted publishing, each with a GitHub Release that includes the VSIX.
- The website at https://sibinms.github.io/turnhuddle/ with release notes for every version.

### Changed
- A clearer Activity Bar icon.

### Fixed
- While Claude streams a list, the typing cursor stays at the end of the text instead of on a line of its own.

## 0.2.0 — 2026-11-25

### Added
- **Chat panel** in the Activity Bar: composer, threaded messages with Markdown rendering, live status words with elapsed time, round timer and relay indicator, Stop while running, copy on each reply.
- **Agreement rounds** (default): Claude and Codex alternate until both end a turn with `VERDICT: AGREE` back to back, or `turnhuddle.maxTurnsPerRound` (default 10) is reached. Verdicts are shown as tags; the outcome is recorded. `turnhuddle.roundMode: fixed` keeps the original three-turn round.
- **Multi-round replies**: a reply appends to the same conversation and runs another round with the full history.
- **Streaming**: Claude's reply appears as it is written; Codex shows its progress steps.
- **Effort settings**: `turnhuddle.codexReasoningEffort` (default `medium`, Turnhuddle-only) and `turnhuddle.claudeEffort`.
- **Conversations and history**: every conversation is saved as a JSON file in the extension's global storage and listed in a Conversations view; reopen, archive (never delete) and restore; several conversations can run at once.
- **Continue from an existing CLI session**: pick a saved Claude Code or Codex session; Claude continues in a fork of it, Codex continues its thread in place; agents with a session receive only new messages.
- Optional official logos via `media/logos/claude.svg` and `codex.svg` (not bundled).
- Commands: Reply, New Conversation, Continue from a Claude Code or Codex Session, Archive, Restore, Reveal History Folder, Refresh Conversations.
- Live test harness driving an isolated VS Code through every feature above.

### Changed
- Claude runs with `--output-format stream-json --include-partial-messages`; Codex runs with `--json`.
- The Output channel is raised only for conversations started from the Command Palette.

## 0.1.0 — 2026-11-25

- Initial release: a three-turn relay (Claude proposes, Codex reviews, Claude replies) through the two CLIs, shown in the Turnhuddle Output channel, with CLI check, cancellation, timeouts and output limits.
