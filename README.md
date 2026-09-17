# PromptSift

[![CI](https://github.com/Tavernari/prompt-sift/actions/workflows/ci.yml/badge.svg)](https://github.com/Tavernari/prompt-sift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Sift the noise. Keep the signal.**

PromptSift is a plugin for Cursor, GitHub Copilot CLI and Claude Code that keeps the expensive model's context for reasoning. A `preToolUse` hook denies the reads, searches and shell commands that would dump a large file into the conversation and points at the bounded alternative; a read-only worker on a cheaper model answers orientation questions across those files; a `postToolUse` ledger measures what entered context and what was kept out, so the saving is a number you read, not one you are told.

## Install

Use your host's plugin manager. The bundle contains the agents, skills, hooks and hook runtime; no `npm install`, API key or project configuration is needed.

**GitHub Copilot CLI** and **Claude Code**:

```text
/plugin marketplace add Tavernari/prompt-sift
/plugin install prompt-sift@prompt-sift
```

Each host discovers its own marketplace manifest and installs its matching bundle.

**Cursor** — import `Tavernari/prompt-sift` under Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo, then install PromptSift from Customize. The public Cursor catalog requires a separate review; this repository is not yet listed there, so accounts without team marketplace import cannot use this route yet.

Any trust confirmation or plugin reload the host asks for is its normal install flow. Remove the plugin through the same manager; it copies nothing into your project.

| Host | Primary specialist | Orientation worker | Writer |
|---|---|---|---|
| Cursor | GPT-5.6 Sol / high | GPT-5.6 Luna / low | GPT-5.6 Luna / xhigh |
| GitHub Copilot CLI | GPT-5.6 Sol / high | GPT-5.6 Luna / low | GPT-5.6 Luna / xhigh |
| Claude Code | Opus / high | Sonnet / low | Sonnet / high |

Agents are discovered by the host and may appear with a `prompt-sift:` prefix. Native agents use your host's authentication and model access; Cursor and Claude Code can substitute unavailable models according to host policy, so check the model shown in your session. Installing a primary specialist does not change an existing parent session.

## What it does

**The hook denies dumps before they enter context.** A full read of a file over `minLines` (350) or `maxBytes` (50 KB) is denied with a message that names the bounded alternative: a search, an `offset`/`limit` window under `maxTargetedLines`, or the worker. Partial reads under the ceiling pass. Read, Grep and the shell are all gated on all three hosts.

**The worker reads so the parent does not have to.** `prompt-sift-<host>-worker` runs at low reasoning effort on purpose: its job is search, a bounded read and a summary under 500 words, and a worker at `xhigh` can cost more per delegation than the session it relieves. It is read-only by contract, not only by permission: a worker handed an edit refuses it and returns orientation (paths, symbols, line ranges) for the parent to edit itself. The `bulk-reader` skill carries the same instructions; `code-writer` delegates reference-based generation to the separate writer, which streams the file to disk through a bundled POSIX helper and returns a summary instead of the code.

**The reminder escalates instead of repeating.** When one result exceeds `maxBytes`, the `postToolUse` hook adds a short reminder; the second oversized result in a session states the running total over the limit and the third names the worker and how to call it.

**The ledger measures it.** One JSON line per tool result — host, project, tool, bytes, `bytes / 4` tokens, duration, a hashed session — never paths, inputs or contents. `stats.sh` reads it back; see Measuring below.

## How the hook decides

A full read of one file is denied when the file is over `minLines` or `maxBytes`, unless the read is a window (`offset`/`limit`, `head`, `sed -n`) at or under `maxTargetedLines`. A content-mode search (`Grep` on Cursor and Claude Code, `grep` on Copilot) of one large file with no `head_limit` at or under that ceiling is the file's read in disguise and is denied the same way; `files_with_matches`, `count`, bounded limits and directory searches pass because the host caps those itself (Claude Code defaults to 250 lines; `head_limit: 0` means unlimited and is denied). The shell recognizer is quote-aware and works command by command: chained direct readers, `head`/`tail` windows, pipes and redirects are handled, and the files of one command are summed (three 200-line files in one `cat` are a 600-line read; a glob is expanded by the hook, never by running it). Dumpers it cannot size from a path are handled on their own terms: `git log -p` without a count is denied as unbounded, `git diff` and `git show` are sized with `git --numstat` (read-only, no pager, no index lock) and denied above `minLines` unless `--stat`-style flags, a pipe into a reducer or a blob path bound them, and `find ... -exec cat` or `xargs cat` are denied unless reduced. The numstat call is the only command the hook ever runs itself.

Where the host says who is calling, the worker's shell is read-only by hook as well as by contract: on Cursor the `subagentStart` hook registers worker ids and the `preToolUse` hook denies a worker's shell command that could change the workspace (redirection, `tee`, `sed -i`, `patch`, `git` writes, builds, unknown commands); on Claude Code the guard keys off `agent_type`. Copilot exposes no caller identity, so its worker relies on its `tools` list.

Binary files (images, PDFs, archives) are never gated, whatever their size: the host renders them itself and a worker cannot summarise them. Missing and unreadable files fail open so the host reports the real filesystem error; shell expansion, dynamic directory changes and control characters in paths are not fully modeled, and unsupported inputs fail open. A hook that cannot run (no `jq`, no download) allows the call and says enforcement is inactive.

**Runtime boundary:** hooks target macOS/Linux and use `/bin/sh`, `jq`, `awk` and standard utilities; no Node.js. If `jq` is missing the hook downloads the pinned [jq 1.8.2](https://github.com/jqlang/jq/releases/tag/jq-1.8.2) for x64/ARM64, verifies its SHA-256 and caches it under `$XDG_CACHE_HOME/prompt-sift/` (`~/Library/Caches/prompt-sift/` on macOS, `~/.cache/prompt-sift/` on Linux), with `curl`, no sudo and no package manager; first use may take up to 12 seconds. `PROMPT_SIFT_AUTO_INSTALL=0` keeps it to a system `jq`. Windows is out of scope for now. This is a context optimization policy, not a security boundary.

Thresholds come from the environment (`PROMPT_SIFT_MIN_LINES`, `PROMPT_SIFT_MAX_BYTES`, `PROMPT_SIFT_MAX_TARGETED_LINES`) or a `.prompt-sift.json` in the project (`minLines`, `maxBytes`, `maxTargetedLines`).

## Routing policy

PromptSift is intended for:

- Orientation across one or more large files.
- Finding ownership, call sites, conventions, and surface-level patterns.
- Tests, fixtures, configuration, and type stubs that follow a clear reference.

Keep these tasks in the primary agent:

- Debugging and root-cause analysis.
- Architecture and design decisions.
- Security, concurrency, privacy, and safety-critical review.
- Edits that require exact context.
- Final correctness judgments.

When a broad read is blocked during one of those tasks, use code search and a targeted read. Partial reads below `maxTargetedLines` pass through.

## Measuring

The plugin records a ledger through each host's `postToolUse` hook: one JSON line per tool result with host, project directory, tool name, bytes, estimated tokens (`bytes / 4`) and duration — never paths, inputs or contents. `preToolUse` denials are recorded with the size of the file kept out, so savings are measured rather than assumed. MCP results count too; in real sessions the largest dumps are often a ticket or a web page, not a file read. The ledger lives in the user cache (`$XDG_CACHE_HOME/prompt-sift/metrics.jsonl`, `~/Library/Caches/prompt-sift/` on macOS, `~/.cache/prompt-sift/` on Linux); `PROMPT_SIFT_METRICS_FILE` overrides it. When one result exceeds `maxBytes`, the hook adds a short reminder to bound the next request; the reminder escalates within a session (the second states the running total of tokens over the limit, the third names the worker and how to call it). Rows carry a `session` field, a `cksum` of the host conversation id, never the id. `PROMPT_SIFT_TELEMETRY=0` disables recording, `PROMPT_SIFT_NUDGE=0` keeps recording without the reminder. A ledger that cannot be written never changes a decision.

Read it with the bundled `context-stats` skill ("how much context did tools use in this project?") or directly:

```bash
/bin/sh "<plugin-root>/runtime/stats.sh" --cwd "$PWD" [--since 2026-09-17T00:00:00Z] [--by-session]
```

The first line of `stats.sh` is the headline: **kept out of context: N% of requested bytes**, where requested is what entered context (every `postToolUse` result) plus what a denial kept out (the size of the file at deny time). `--by-session` breaks the same share down per conversation, so a session that leaned on the worker can be compared with one that did not. Two honesty rules are built in: denials with no results are reported as "the postToolUse hook is not running", never as a 100% saving, and the share is of *requested* bytes, not of the session's total tokens — the model's own output and the system prompt are outside what the hook can see. This README quotes no percentage because the number is yours to measure: run a real session with the plugin installed, then `stats.sh --by-session`. Denied bytes are an upper bound (the host would have capped some of them) and tokens are `bytes / 4`; treat both as directional.

## Development

```bash
npm test
npm run check       # tests, lint and a plugin-bundle freshness check
npm run build:plugins
```

The bundles under `plugins/` are generated from `templates/` and `scripts/plugin/` by `scripts/build-plugins.js`; edit the sources, rebuild, commit both. Tests cover hook schemas on all three hosts, the line and byte thresholds, quoted paths, chained shell commands, pipes, redirects, the git and find dumpers, the worker guard, agent contracts, the escalating reminder and `stats.sh`. CI exercises isolated plugin bundles and script behaviour on Linux and macOS; it does not run authenticated model sessions or establish a savings percentage.

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first and report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues. Installation references: [Cursor marketplaces](https://cursor.com/docs/plugins), [Copilot plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing), [Claude Code plugins](https://code.claude.com/docs/en/discover-plugins).

## Legacy: npm install and the external API worker

The original PromptSift was a Node.js CLI (`prompt-sift read`, `write`, `inspect`, `stats`) that sends selected files to an OpenAI-compatible worker, plus an installer that writes project-local hooks and agents. It still works and is still tested, but the plugins are the supported path. It remains useful for a worker outside your host's model access, such as a local Ollama. Everything about it, including configuration, security notes and compatibility, is in [docs/EXTERNAL_API_MODE.md](docs/EXTERNAL_API_MODE.md).

## License

MIT
