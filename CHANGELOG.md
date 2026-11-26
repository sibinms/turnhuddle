# Changelog

All notable changes to Turnhuddle are listed here. Versions follow [Semantic Versioning](https://semver.org/).

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
