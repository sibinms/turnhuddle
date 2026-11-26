<p align="center">
  <img src="https://sibinms.github.io/turnhuddle/icon.png" alt="Turnhuddle" width="96" height="96" />
</p>

<h1 align="center">Turnhuddle</h1>

<p align="center"><b>Two coding agents in one VS Code chat.</b><br />Pick who drafts and who reviews, with any model: Claude Code, Codex or Gemini. They keep going until both agree.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Turnhuddle.turnhuddle"><img src="https://img.shields.io/visual-studio-marketplace/v/Turnhuddle.turnhuddle?label=Marketplace&color=d97757" alt="Visual Studio Marketplace version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Turnhuddle.turnhuddle"><img src="https://img.shields.io/visual-studio-marketplace/i/Turnhuddle.turnhuddle?label=Installs&color=10a37f" alt="Installs" /></a>
  <a href="https://github.com/sibinms/turnhuddle/actions/workflows/ci.yml"><img src="https://github.com/sibinms/turnhuddle/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="MIT licence" /></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Turnhuddle.turnhuddle"><b>Install</b></a> ·
  <a href="https://sibinms.github.io/turnhuddle/"><b>Website</b></a> ·
  <a href="https://sibinms.github.io/turnhuddle/whats-new/"><b>What's new</b></a> ·
  <a href="docs/DEVELOPMENT.md"><b>Developing</b></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://sibinms.github.io/turnhuddle/screenshots/chat-dark.png" />
    <img src="https://sibinms.github.io/turnhuddle/screenshots/chat-light.png" alt="VS Code with the Turnhuddle chat beside the code: Claude Opus 5.5 and Codex GPT-6.2-Sol review a rate-limiting plan and both agree after four turns" width="900" />
  </picture>
</p>

## Why

Asking one coding agent gets you one opinion. Asking two means copying answers back and forth between tools. Turnhuddle does the back-and-forth for you: one agent drafts, the other critiques, the drafter revises, and the round ends only when **both** say the answer is final.

It drives the official command-line tools you already have, under your own accounts: **Claude Code**, **Codex** and, in preview, the **Gemini CLI**. No new logins, no server, no telemetry. More providers are on the way; each is one entry in a registry (see [Adding a provider](docs/DEVELOPMENT.md#adding-a-provider)).

## Features

### Any agent, any model, in either seat

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://sibinms.github.io/turnhuddle/screenshots/models-dark.png" />
  <img src="https://sibinms.github.io/turnhuddle/screenshots/models-light.png" alt="The Turnhuddle agent picker listing Claude, Codex and Gemini models found on this machine, with Swap drafter and reviewer at the end" width="900" />
</picture>

The two names under the message box are the seats: the **drafter** proposes and revises, the **reviewer** critiques. Click one to choose its agent and model, like Claude Code's model picker. The list shows what's on your machine: the Codex models your account has, Claude's aliases plus the models you've used recently, and Gemini's. Type any other model id, seat the same provider twice with two models (Opus drafts, Haiku reviews), or swap the seats. Your choice applies to the open conversation and to new ones, and every message shows which model wrote it.

### Rounds that end when both agree

Every turn ends with a verdict, shown as **agrees** or **continues** next to the agent's name. Two agreements in a row finish the round. A turn limit, 10 by default, stops a round that goes in circles, and says so.

### Watch Claude write

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://sibinms.github.io/turnhuddle/screenshots/streaming-dark.png" />
  <img src="https://sibinms.github.io/turnhuddle/screenshots/streaming-light.png" alt="Claude's revised plan appearing word by word in the Turnhuddle chat" width="900" />
</picture>

Claude's reply streams in as it's written, with a live status like *Noodling… 18s* while each agent works. Codex shows what it's doing, then its review. Replies render as Markdown: code blocks, lists, tables.

### Every conversation, saved, and continued from the CLIs

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://sibinms.github.io/turnhuddle/screenshots/continue-dark.png" />
  <img src="https://sibinms.github.io/turnhuddle/screenshots/continue-light.png" alt="A picker listing recent Claude Code and Codex sessions over the Turnhuddle conversations list" width="900" />
</picture>

Conversations are saved on your machine, each with a name: **Untitled** until you send the first message, then its first line; click the title to rename it. The chat header works like Claude Code's: **bookmark** the one you're in, open your **history** from the clock (bookmarked first, searchable), or start a **new** one. Run several at once, archive instead of delete. Started something in the Claude Code or Codex CLI? Pick that session and continue it here, with everything the agent already knows.

### And more

- **Reply to go deeper.** A follow-up runs another round on the same conversation, with the full history.
- **Speed you control.** Set how hard Codex and Claude think, for Turnhuddle only (from the picker's *Effort and other settings…*).
- **Updates itself.** Checks GitHub daily and installs new versions after verifying their checksum. Marketplace installs are also updated by VS Code.

## Get started

1. Install the CLIs you want to seat and sign in to each once in a terminal: the [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), the [Codex CLI](https://developers.openai.com/codex/cli) and, optionally, the [Gemini CLI](https://github.com/google-gemini/gemini-cli). Claude drafts and Codex reviews until you choose otherwise.
2. Install **Turnhuddle** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Turnhuddle.turnhuddle), or download the VSIX from [Releases](https://github.com/sibinms/turnhuddle/releases) and run **Extensions: Install from VSIX…**.
3. Run **Turnhuddle: Check CLI Installations** to see which CLIs are found.
4. Open the Turnhuddle view in the Activity Bar, type in **Ask Claude and Codex…** and press **Enter**. Click a name under the box to change who drafts or reviews.

Turnhuddle finds the CLIs by itself: on your PATH, in common install folders, or bundled with the Claude Code and Codex VS Code extensions. If you keep them somewhere unusual, point `turnhuddle.claudePath`, `turnhuddle.codexPath` or `turnhuddle.geminiPath` at them.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `turnhuddle.drafter`, `turnhuddle.reviewer` | `claude`, `codex` | Who sits in each seat for new conversations: `provider` or `provider:model`, e.g. `claude:opus`, `codex:gpt-6.2-sol`, `gemini:gemini-2.5-pro`. Set by the picker. |
| `turnhuddle.roundMode` | `agreement` | `agreement`: agents alternate until both agree. `fixed`: Claude, Codex, Claude. The composer's mode chip switches it. |
| `turnhuddle.maxTurnsPerRound` | `10` | Most agent turns in one agreement round (2–30). |
| `turnhuddle.codexReasoningEffort` | `medium` | Codex's reasoning effort for Turnhuddle turns only. `inherit` uses your Codex config. |
| `turnhuddle.claudeEffort` | `inherit` | Passes `--effort` to Claude: `low` to `max`. |
| `turnhuddle.claudePath`, `turnhuddle.codexPath`, `turnhuddle.geminiPath` | `claude`, `codex`, `gemini` | Leave as is to find the CLIs automatically, or set a full path. |
| `turnhuddle.timeoutSeconds` | `180` | Per-turn time limit. |
| `turnhuddle.checkForUpdates` | `true` | Daily check for a newer release on GitHub. |
| `turnhuddle.vendorLogos` | `true` | Show the Claude and Codex logos from their installed VS Code extensions. |

## Commands

| Command | |
|---|---|
| **Turnhuddle: Start Conversation** | Start a new conversation from an input box. |
| **Turnhuddle: Reply in Conversation** | Run another round on the open conversation. |
| **Turnhuddle: Continue from a Claude Code or Codex Session** | Pick a CLI session to continue. |
| **Turnhuddle: New Conversation** · **Cancel Conversation** | Clear the chat · stop the running round. |
| **Turnhuddle: Choose the Drafter's / Reviewer's Agent and Model** · **Swap Drafter and Reviewer** | The same as clicking the seat names. |
| **Turnhuddle: Rename Conversation** | Rename the open conversation (or click its title). |
| **Turnhuddle: Check CLI Installations** · **Check for Updates** | Find the CLIs · look for a new version. |
| **Turnhuddle: Reveal History Folder** | Open the folder where conversations are saved. |

## Privacy and safety

- Your task and the replies go to the agents you seat, through their own CLIs, under your accounts; their usage charges and data policies apply.
- Conversations are plain JSON files in VS Code's storage on your machine. Nothing is deleted for you; archived conversations stay until you remove them.
- No telemetry. The only request Turnhuddle makes itself is the daily update check to GitHub, which you can turn off.
- Claude runs in plan mode, Codex in a read-only sandbox and Gemini in its default headless mode (which leaves out tools that need approval), and all are told to discuss only. These are the CLIs' own permission modes, not a security boundary for hooks, plugins or MCP servers you've installed.

Details: [privacy](https://sibinms.github.io/turnhuddle/privacy.html).

## Limits

- Every turn replays the conversation to the CLI, so long conversations cost more per round.
- Tested on macOS. Windows and Linux should work but aren't verified.
- Gemini support is a **preview**: it's built against the Gemini CLI's documented `stream-json` output and tested with recorded output, not yet with the real CLI. Continuing a Gemini CLI session isn't supported yet.
- Turnhuddle doesn't bundle the Claude or OpenAI logos, which belong to Anthropic and OpenAI. When the Claude Code and Codex VS Code extensions are installed, it shows the logos those extensions ship, from where they're installed on your machine; otherwise it shows initials. Turn this off with `turnhuddle.vendorLogos`.

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/sibinms/turnhuddle/issues). To build, test or release Turnhuddle, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); the [changelog](CHANGELOG.md) lists every version.

## Licence

[MIT](LICENSE)
