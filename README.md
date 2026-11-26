# Turnhuddle

Your coding agents, in conversation.

Standalone VS Code extension connecting Claude Code and Codex through their CLIs. No changes to vendor extensions required.

Version 0.2 sends a task to Claude, then lets Claude and Codex alternate, proposal, review, revision, until both end a turn with `VERDICT: AGREE` back to back or the turn limit is reached. A reply runs another round on the same conversation. Each turn receives the shared conversation ID and full message history. The **Turnhuddle** chat panel shows the exchange live; the **Turnhuddle** Output channel keeps the plain text.

## Chat panel

The Turnhuddle icon in the Activity Bar opens the **Conversation** panel, laid out like the vendor chat panels. Type a task into the composer at the bottom and press Enter (Shift+Enter inserts a new line): that starts the conversation. Claude proposes an approach, Codex reviews it, then Claude answers the critique. Type again to reply: the follow-up is appended to the same conversation and both agents run another round with the full history. Rounds are separated in the thread.

### How a round ends

In the default **agreement** mode Claude proposes, then Claude and Codex alternate: each reviews the other's latest response, says what still needs to change or that it is final, and ends with one line, `VERDICT: AGREE` or `VERDICT: CONTINUE`. The extension strips that line, shows it as an "agrees" or "continues" tag next to the agent's name, and ends the round when both agents have said AGREE back to back. `turnhuddle.maxTurnsPerRound` (default 10, 2 to 30) caps the round; when it is reached the thread says "no agreement after n turns" and the state reads "No agreement" instead of "Agreed". A reply with no verdict line counts as CONTINUE. Every turn replays the history, so long rounds cost more; Stop ends a round at any point. Set `turnhuddle.roundMode` to `fixed` for the original three-turn round (Claude proposes, Codex reviews, Claude replies), which never parses verdicts. The `+` in the title row (or the panel's title-bar icon, or **Turnhuddle: New Conversation**) clears the thread and starts fresh.

The title row shows the task, the state and the conversation ID in its tooltip. Your messages appear as cards with their time; each agent reply is full-width text under an author row (avatar, name, time, and a copy button on hover) with the agents' Markdown rendered: headings, lists, code blocks with a language tag, tables, blockquotes and links to `http`, `https` and `mailto` targets only. While an agent is working its author row shows an animated status such as "Pondering… 12s", cycling through the words in `THINKING_WORDS` in `src/conversationView.ts` (one list; add to it freely). Claude's reply streams in below it as it is written; Codex's CLI reports completed steps rather than partial text, so its row shows what it is doing (reasoning, running a command) and then the whole reply.

The composer's toolbar shows the round and its elapsed time while running, which of the three turns is in progress, and the effort setting (click it to open Turnhuddle's settings). The round button sends; while a conversation runs it becomes a stop button, and the panel's title bar shows a stop icon as well.

## Conversations and history

Every conversation is saved on this machine as one JSON file under VS Code's global storage for the extension (`…/globalStorage/turnhuddle.turnhuddle/conversations/`; **Turnhuddle: Reveal History Folder** opens it). The **Conversations** list above the chat shows them newest first with their state, round count and age; click one to open it in the chat and reply to it. Conversations survive window reloads; one that was still running when the window closed is shown as failed, and a reply continues from the messages that did arrive. The clock icon in the chat's title row focuses the list.

### Continue from an existing CLI session

**Turnhuddle: Continue from a Claude Code or Codex Session** (also the ▶ icon in the Conversations list) shows the sessions the two CLIs have saved on this machine for the open folder (toggle to all folders), newest first with each session's title or first prompt. Pick one, type the first message, and a Turnhuddle conversation starts in which that agent keeps the full context of its session while the other joins as reviewer. Claude's session is forked, so the original is left untouched and the fork accumulates the Turnhuddle turns; a Codex thread is continued in place, so Turnhuddle's turns are appended to it. In a continued conversation the agent with a session receives only the new messages each turn instead of a replay; the other agent still gets the full Turnhuddle history. The title row shows "from Claude" or "from Codex" with the source session in its tooltip.

This reads the CLIs' own transcript files under `~/.claude/projects/` and `~/.codex/sessions/` (read-only; the formats are undocumented and may change with CLI updates) and uses `claude --resume --fork-session` and `codex exec resume`, so it works only for sessions recorded on this machine with the same accounts. A resumed Codex thread keeps the sandbox policy it was recorded with.

Several conversations can run at once: start another with the `+` button or **Turnhuddle: Start Claude ↔ Codex Conversation** while one is running, and switch between them in the list; each runs one round at a time, and Stop applies to the conversation shown. Nothing is ever deleted by the extension: **Archive** moves a conversation into an "Archived (safe to delete)" group, **Restore** brings it back, and the files stay on disk for you to review and remove yourself. The Output channel still receives every message as before; it is raised when a conversation is started from the Command Palette and left where it is when started from the panel.

Official Claude and Codex logos are not included: they are Anthropic's and OpenAI's trademarks, so check their brand guidelines before redistributing them. The built-in avatars are initials in brand-like colours. To show the official marks, put `claude.svg` and `codex.svg` into `media/logos/` of the installed extension (or of this folder when running from F5) and reopen the panel; see `media/logos/README.txt`.

## Development

Requires Node.js 22+, npm, VS Code 1.95+, and authenticated Claude Code and Codex CLIs.

```sh
npm ci
npm test
npm run package
```

`npm test` runs the Node unit tests (no VS Code, no CLI calls). `npm run test:vscode` launches an isolated VS Code Extension Development Host (own user-data and extensions directories, a disposable workspace) and drives the real commands: CLI check, cancellation mid-invocation, an invalid executable path, then a full three-turn conversation and a follow-up round on it, the saved history (list, file on disk, reopen, archive, restore), two short conversations running at the same time, a conversation continued from a real Claude Code session and one agreement-mode round, asserting the panel state after each step and the live message arrivals during the rounds. It calls the authenticated CLIs and incurs usage. Point it at executables that are not on PATH with `TURNHUDDLE_CLAUDE_PATH` and `TURNHUDDLE_CODEX_PATH`; set `TURNHUDDLE_VSIX` to verify a packaged VSIX instead of the source tree. It writes `report.json` with the exchange into its work directory.

Open this folder in VS Code and press F5. In the Extension Development Host, open a trusted development folder, click the Turnhuddle icon in the Activity Bar and type a task. **Turnhuddle: Check CLI Installations**, **Turnhuddle: Start Claude ↔ Codex Conversation** (asks for the task in an input box and always starts a new conversation), **Turnhuddle: Reply in Conversation**, **Turnhuddle: New Conversation** and **Turnhuddle: Cancel Conversation** remain available from the Command Palette.

Alternatively, run **Extensions: Install from VSIX** and select the generated VSIX.

## Configuration

Set `turnhuddle.claudePath` and `turnhuddle.codexPath` in user settings if the executables are not on VS Code's PATH. Use executable paths without flags, shell aliases or `~`. These settings are machine-scoped.

Turn speed is mostly model thinking time. `turnhuddle.codexReasoningEffort` (default `medium`) sets Codex's reasoning effort for Turnhuddle turns only, without changing your Codex config; `inherit` uses that config (a config set to `ultra` or `xhigh` makes each Codex review take a minute or more). `turnhuddle.claudeEffort` (default `inherit`) passes `--effort` to Claude when set to `low`, `medium`, `high`, `xhigh` or `max`. The default per-turn timeout is 180 seconds and combined stdout/stderr limit is 1 MiB. Cancel using the panel's Stop button, the progress notification or **Turnhuddle: Cancel Conversation**. Cancellation kills the running CLI process group; later turns do not start and the Output channel notes the cancellation.

`turnhuddle.start` accepts an optional `{ "task": "…", "source": "sidebar" }` argument (for keybindings or automation; `source` only decides whether the Output channel is raised) and returns `{ status, id, messages, error }` for the round it ran, where `status` is `completed`, `cancelled`, `failed` or `skipped`. `turnhuddle.reply` takes `{ "message": "…", "source": "sidebar", "id": "…" }`, continues the open conversation (or `id`, or starts one when none is open) and returns the same shape with the new round's messages. `turnhuddle.clear` closes the open conversation in the chat (it stays in the list). `turnhuddle.open`, `turnhuddle.archive` and `turnhuddle.restore` take a conversation ID; `turnhuddle.listSessions` returns `[{ id, title, status, createdAt, updatedAt, archived, messages, rounds, cwd, file }]`; `turnhuddle.refreshSessions` reloads the list from disk. `turnhuddle.continueFrom` takes `{ "provider": "claude" | "codex", "sessionId": "…", "title": "…", "message": "…", "source": "sidebar" }` (all optional: without a session it shows the picker, without a message it asks) and returns the same `{ status, id, messages, error }`; `turnhuddle.listVendorSessions` (hidden) returns `[{ provider, id, title, cwd, updatedAt, file, bytes }]`. The exported API adds `listSessions()`, `runningIds()`, `historyDir()` and `listVendorSessions(all?)`. `turnhuddle.getState` (hidden from the Command Palette) returns the panel's state: `{ status, task, id, startedAt, finishedAt, error, messages }` with `status` one of `idle`, `running`, `completed`, `cancelled` or `failed`, and ISO timestamps. The extension's exported API offers the same `getState()` plus `onDidChangeState(listener)`.

The installation check runs `--version`; it does not check authentication. Authenticate in a terminal using each vendor's instructions before starting a conversation.

## Behaviour and limits

Claude runs with `--permission-mode plan --output-format stream-json --include-partial-messages`; Codex runs with `exec --sandbox read-only --json`. These are CLI permission modes, not a security boundary for installed hooks, plugins or MCP servers. Your existing CLI configuration and credentials apply. Use configurations you trust.

Tasks and responses are sent to both providers. Their normal usage charges and data policies apply. The extension adds no telemetry; conversations are stored as plain JSON files in the extension's global storage on this machine (see above) and the Output panel keeps the session's text. Vendor CLIs may retain their own sessions. Partial results remain visible if a turn fails. Errors stop the relay. When a CLI exits with an error, the message includes a short, colour-stripped excerpt of its last stderr output; when Claude reports an error, its own message is included.

This version launches fresh CLI processes and replays the full history to each one, so long conversations cost more per round. It does not attach to existing vendor extension conversations or provide autonomous peer requests. Several conversations can run at once; each runs one round at a time. macOS is the initial target; Windows process-tree cancellation has not been verified.

Next milestones: persistent CLI sessions for every conversation (no history replay per turn), then either agent initiating collaboration.

## Interface references

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- Codex: `codex exec --help` for the installed version.

## Updates

Installs from the Marketplace are updated by VS Code itself. For everyone, including VSIX installs from GitHub, Turnhuddle checks GitHub once a day, 15 seconds after VS Code starts, for a newer release. If there is one, a notification offers **Install Update**, **What's New** and **Skip This Version**. Install downloads that release's VSIX from GitHub, checks its size, format and the SHA-256 digest GitHub publishes for it, installs it and offers to reload the window. **Turnhuddle: Check for Updates** runs the check on demand. Set `turnhuddle.checkForUpdates` to `false` to turn the daily check off; the request to GitHub carries nothing about you or your work.

## Website and release notes

The website at <https://sibinms.github.io/turnhuddle/> lives in `site/` and is published by the **Website** workflow (`.github/workflows/pages.yml`) to GitHub Pages whenever `site/` or `release-notes/` change on `main`, after every Release, or on demand. It follows the same design and release-notes system as the Kube Console site.

- **Release notes** live in `release-notes/<version>/notes.json` with optional screenshots beside them as `<name>-light.png` and `<name>-dark.png`. `scripts/whats-new.cjs` turns them into the site's *What's new* page, the "New in …" pill on the home page, the sitemap entry and the GitHub Release text. Only versions with a `v*` tag appear on the site, so notes can be written before a release.
- **Screenshots** come from `npm run screenshots`: it renders the extension's real chat panel HTML inside a VS Code-style window with sample conversations, in light and dark, using headless Chrome. Copy the ones a release needs into its notes folder.
- **Preview locally** with `npm run site` and any static server on `site/` (for example `python3 -m http.server -d site`).

## Publication

Releases are published by GitHub Actions through the Marketplace's **trusted publishing**: no token is stored anywhere.

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: release notes exist for the version in `package.json`, install, compile, the Node unit tests, and a VSIX build kept as a downloadable artifact for 14 days.
- **Release** (`.github/workflows/release.yml`) runs when a tag like `v0.2.1` is pushed. It checks that the tag equals `v` + the `version` in `package.json` and that its release notes are valid, runs the tests, builds the VSIX, publishes it with `vsce publish --oidc`, and creates a GitHub Release with the VSIX attached and the release notes as text. The Website workflow then republishes the site.

The publisher `Turnhuddle` has a trusted-publishing policy for repository `sibinms/turnhuddle`, workflow `release.yml` and environment `marketplace`. Renaming the workflow file or the environment breaks publishing until the policy is updated to match. To require your approval before each publish, add yourself as a required reviewer on the `marketplace` environment (repository Settings → Environments).

### To release a version

1. Run `npm run test:vscode` locally (it needs the signed-in CLIs, so CI cannot run it).
2. Write `release-notes/<version>/notes.json` (and screenshots, if any); `npm run check-notes` validates the notes for the version in `package.json`.
3. Bump `version` in `package.json`, add a `## <version> — <date>` section to `CHANGELOG.md`, and commit.
4. Tag and push:

   ```bash
   git tag -a v0.2.1 -m "Turnhuddle 0.2.1" && git push origin main --tags
   ```

5. Watch the Release and Website workflows in the repository's Actions tab. The Marketplace usually shows the new version a few minutes after Release finishes.

The Marketplace does not accept pre-release suffixes such as `-beta.1` in the version; publish a pre-release with an odd minor version and `vsce publish --pre-release` if that is ever needed. The official Claude and Codex logos are deliberately not bundled; see *Chat panel*.
