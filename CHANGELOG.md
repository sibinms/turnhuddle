# Changelog

All notable changes to Turnhuddle are listed here. Versions follow [Semantic Versioning](https://semver.org/).

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
