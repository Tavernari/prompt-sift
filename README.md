# PromptSift

[![CI](https://github.com/Tavernari/prompt-sift/actions/workflows/ci.yml/badge.svg)](https://github.com/Tavernari/prompt-sift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Sift the noise. Keep the signal.**

PromptSift keeps premium coding agents focused on reasoning. It blocks broad reads that would flood the primary context, redirects low-reasoning I/O to a smaller worker model, caches identical work, and measures the estimated context saved.

It has native adapters for Cursor and GitHub Copilot and works with Ollama or any OpenAI-compatible chat-completions endpoint.

## Why this design

A cheap model alone does not save primary-agent context. The routing boundary must happen before a large tool result reaches that context. PromptSift therefore combines:

- Native `preToolUse` hooks that enforce the boundary.
- A provider-neutral CLI instead of an editor-specific backend.
- Both line and byte thresholds, so minified files are not missed.
- Content-addressed result caching for repeated questions against unchanged files.
- Direct-to-disk generation with overwrite protection.
- Explicit exclusions for work that needs strong reasoning.
- Local JSONL metrics so savings can be measured instead of assumed.

## Install through plugins

Use your host's plugin manager. The plugin contains the agents, defaults, hooks and hook runtime; no `npm install`, `prompt-sift install`, API key or project configuration is needed for native mode.

**GitHub Copilot CLI** — register the repository once, then install:

```text
/plugin marketplace add Tavernari/prompt-sift
/plugin install prompt-sift@prompt-sift
```

**Claude Code** — use the same commands inside Claude Code:

```text
/plugin marketplace add Tavernari/prompt-sift
/plugin install prompt-sift@prompt-sift
```

Each host discovers its own marketplace manifest and installs its matching bundle.

**Cursor** — import `Tavernari/prompt-sift` under Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo. Install PromptSift from Customize. The public Cursor catalog requires a separate review; this repository is not yet listed there. On accounts without team marketplace import, this distribution route is not available until public approval.

Any trust confirmation or plugin reload requested by the host is part of its normal install flow. PromptSift has no post-install setup command. Remove the plugin through the same manager; it does not copy files into your project.

| Host | Primary specialist | Orientation worker |
|---|---|---|
| Cursor | GPT-5.6 Sol / high | GPT-5.6 Luna / low |
| GitHub Copilot CLI | GPT-5.6 Sol / high | GPT-5.6 Luna / low |
| Claude Code | Opus / high | Sonnet / low |

Agents are discovered by the host and may appear with a `prompt-sift:` prefix. Delegate orientation to the worker; use the primary specialist for complex reasoning and final review. Installing a primary specialist does not change an existing parent session. Workers use bounded reads and return concise summaries; they do not recursively delegate or call an external API worker.

The orientation worker runs at low reasoning effort on purpose: its job is search, a bounded read and a short summary, and a worker at `xhigh` can cost more per delegation than the parent session it was meant to relieve (a session routed to Grok 4.6 delegating to Luna/xhigh paid for reasoning the task never needed). Raise it in your own agent file if your codebase needs it; the writer keeps `xhigh` because it produces code.

Native agents use your host's authentication and model access. Copilot declares the model as required. Cursor and Claude Code can substitute unavailable models according to host policy; check the model shown in your session.

**Runtime boundary:** plugin hooks target macOS/Linux and use `/bin/sh`, `jq`, `awk`, and standard system utilities. No Node.js or npm is used by the plugins. If `jq` is missing, the hook automatically downloads the pinned jq 1.8.2 binary for x64/ARM64, verifies its SHA-256 before execution, and caches it under `$XDG_CACHE_HOME/prompt-sift/` (or `~/Library/Caches/prompt-sift/` on macOS, `~/.cache/prompt-sift/` on Linux). This uses `curl` and a system SHA-256 utility, with no sudo or global package installation. First use may take up to 12 seconds for the download; later hooks reuse the verified cache.

Set `PROMPT_SIFT_AUTO_INSTALL=0` for offline/system-jq-only operation. If download, integrity verification or runtime startup fails, the hook warns and allows normal work; native subagents remain available. Downloads come only from the [official jq 1.8.2 release](https://github.com/jqlang/jq/releases/tag/jq-1.8.2). Windows is out of scope for now. Node.js remains a development/test dependency and is used by the optional external API CLI.

Binary files (images, PDFs, archives) are never gated, whatever their size: the host renders them itself and a worker cannot summarise them. The worker is read-only by contract, not only by host permission: Cursor's `readonly: true` blocks the edit tools but a worker handed an edit will reach for the shell, so the worker refuses delegated changes outright and the parent keeps surgical edits for itself. Where the host tells the hook who is calling, the hook enforces it too: on Cursor the `subagentStart` hook registers worker ids and the `preToolUse` hook denies a worker's shell command that could change the workspace (redirection, `tee`, `sed -i`, `patch`, `git` writes, builds, unknown commands); on Claude Code the same guard keys off `agent_type`. Copilot exposes no caller identity, so its worker relies on its `tools` list. A content-mode search (`Grep` on Cursor and Claude Code, `grep` on Copilot) of one large file with no `head_limit` at or under the targeted-read ceiling is that file's read in disguise and is denied the same way; `files_with_matches`, `count`, bounded limits and directory searches pass, because the host caps those itself (Claude Code: 250 lines by default, `head_limit: 0` is unlimited and is denied). The shell recognizer supports quoted paths, chained direct readers, head/tail windows, pipes and redirects, and it sums the files of one command (a glob is expanded by the hook, never by running it). Dumpers it cannot size from a path are handled on their own terms: `git log -p` without a count is denied as unbounded, `git diff` and `git show` are sized with `git --numstat` (read-only, no pager, no index lock) and denied above `minLines` unless `--stat`-style flags, a pipe into a reducer or a blob path bound them, and `find ... -exec cat` or `xargs cat` are denied unless reduced. It never executes the command it inspects; the numstat call is the only command the hook runs itself. Shell expansion, dynamic working-directory changes and control characters in paths are not fully modeled; unsupported inputs fail open. This is a context optimization policy, not a security boundary.

Installation references: [Cursor marketplaces](https://cursor.com/docs/plugins), [Copilot plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing), [Claude Code plugins](https://code.claude.com/docs/en/discover-plugins).

## Optional npm installation

For users who specifically want project-local files or the external API CLI, Node.js 22+ is required:

```bash
npm install --save-dev github:Tavernari/prompt-sift
npx prompt-sift install --host all
```

Use either plugin mode or project-local hooks for a given host. Existing npm installations should remove only their PromptSift hook entries before switching to plugins to avoid running both copies. Preserve unrelated hooks.

## What npm mode installs

| File | Purpose |
|---|---|
| `.prompt-sift.json` | Shared thresholds and optional external API worker configuration |
| `.cursor/agents/`, `.github/agents/`, `.claude/agents/` | Native primary and worker definitions for selected hosts |
| `.cursor/rules/prompt-sift.mdc` | Automatic Cursor delegation guidance |
| `.claude/settings.json` | Claude Code hook and default model, when selected |
| `.prompt-sift/run-hook.cjs` | Small cross-platform, fail-open hook runner |
| `.cursor/hooks.json` | Cursor `preToolUse` adapter; existing hooks are preserved |
| `.github/hooks/prompt-sift.json` | Copilot `preToolUse` adapter |
| `.agents/skills/prompt-sift/SKILL.md` | Portable routing guidance for agents |
| `.github/instructions/prompt-sift.instructions.md` | Copilot repository instructions |

Running the installer again is idempotent. Existing `.prompt-sift.json` and skill files are kept unless `--force` is passed.

## Optional external API mode

Set `OPENAI_API_KEY` before using these commands.

Summarize several files without putting their full contents in the primary agent context:

```bash
npx prompt-sift read \
  --question "Which types own profile refresh and where are they called?" \
  --path Sources/ProfileService.swift \
  --path Sources/SessionCoordinator.swift
```

Inspect what would be sent without contacting the worker:

```bash
npx prompt-sift read \
  --question "What does this module own?" \
  --path Sources/LargeModule.swift \
  --dry-run
```

Generate predictable code by matching an existing reference:

```bash
npx prompt-sift write \
  --spec "Add success, empty, and server-error tests for UserService" \
  --reference Tests/OrderServiceTests.swift \
  --target Tests/UserServiceTests.swift
```

The target must not exist. Replacement requires an explicit `--force`. PromptSift strips only a single wrapping markdown fence, so fenced examples inside code or docstrings are preserved.

## Configuration

`.prompt-sift.json`:

```json
{
  "minLines": 350,
  "maxBytes": 50000,
  "maxTargetedLines": 350,
  "maxPayloadBytes": 400000,
  "requestTimeoutMs": 60000,
  "cache": true,
  "cacheDir": ".prompt-sift/cache",
  "metricsFile": ".prompt-sift/metrics.jsonl",
  "primaryAgent": {
    "model": "gpt-5.6-sol",
    "reasoningEffort": "high"
  },
  "provider": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5.6-luna",
    "apiKeyEnv": "OPENAI_API_KEY",
    "reasoningEffort": "low"
  }
}
```

Environment variables override the most common settings:

| Variable | Purpose |
|---|---|
| `PROMPT_SIFT_BASE_URL` | OpenAI-compatible `/v1` base URL |
| `PROMPT_SIFT_MODEL` | Worker model identifier |
| `OPENAI_API_KEY` | Default worker credential; never place it in the JSON file |
| `PROMPT_SIFT_REASONING_EFFORT` | Worker reasoning level, e.g. `low` (the default) or `medium` |
| `PROMPT_SIFT_MIN_LINES` | Full-read line threshold |
| `PROMPT_SIFT_MAX_BYTES` | Full-read byte threshold |
| `PROMPT_SIFT_MAX_TARGETED_LINES` | Largest partial read that bypasses delegation |
| `PROMPT_SIFT_TIMEOUT_MS` | Worker request timeout |

Existing installations keep their configuration. To migrate, update `provider` and add `primaryAgent` as above. For a local worker, use:

```json
{
  "provider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5-coder:3b",
    "apiKeyEnv": "PROMPT_SIFT_API_KEY",
    "reasoningEffort": null,
    "temperature": 0.2
  }
}
```

Changing the worker model clears inherited reasoning defaults unless explicitly configured. Reasoning requests omit `temperature`; cache keys include reasoning settings. Higher reasoning can increase latency and billed worker tokens; context savings are not a guarantee of lower total cost.

Model references: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

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

Shell reads are parsed quote-aware and command-by-command. Paths with spaces, leading whitespace, chained commands, `head -n`, pipes, and output redirects are handled deliberately. Missing and unreadable files fail open so the host reports the real filesystem error.

## Security

Native subagents process files through your host provider. Direct CLI commands send selected files to the configured external worker; its default endpoint is OpenAI. Configure a local Ollama endpoint when code must remain on your machine.

PromptSift refuses common credential paths such as `.env`, private keys, keystores, and token/secret files. `--allow-sensitive` is an explicit escape hatch, not a recommendation. File contents are wrapped as untrusted data and the worker is told never to follow embedded instructions.

Caches are stored with user-only permissions where supported. Cache and metrics paths are added to `.gitignore` by the installer.

## Metrics

**Plugin mode** records a ledger through each host's `postToolUse` hook: one JSON line per tool result with host, project directory, tool name, bytes, estimated tokens (`bytes / 4`) and duration — never paths, inputs or contents. `preToolUse` denials are recorded with the size of the file kept out, so savings are measured rather than assumed. MCP results count too; in real sessions the largest dumps are often a ticket or a web page, not a file read. The ledger lives in the user cache (`$XDG_CACHE_HOME/prompt-sift/metrics.jsonl`, `~/Library/Caches/prompt-sift/` on macOS, `~/.cache/prompt-sift/` on Linux); `PROMPT_SIFT_METRICS_FILE` overrides it. When one result exceeds `maxBytes`, the hook adds a short reminder to bound the next request; the reminder escalates within a session (the second states the running total of tokens over the limit, the third names the worker and how to call it). Rows carry a `session` field, a `cksum` of the host conversation id, never the id. `PROMPT_SIFT_TELEMETRY=0` disables recording, `PROMPT_SIFT_NUDGE=0` keeps recording without the reminder. A ledger that cannot be written never changes a decision.

Read it with the bundled `context-stats` skill ("how much context did tools use in this project?") or directly:

```bash
/bin/sh "<plugin-root>/runtime/stats.sh" --cwd "$PWD" [--since 2026-09-17T00:00:00Z] [--by-session]
```

### Measuring what it saves

The first line of `stats.sh` is the headline: **kept out of context: N% of requested bytes**, where requested is what entered context (every `postToolUse` result) plus what a denial kept out (the size of the file at deny time). `--by-session` breaks the same share down per conversation, so a session that leaned on the worker can be compared with one that did not. Two honesty rules are built in: denials with no results are reported as "the postToolUse hook is not running", never as a 100% saving, and the share is of *requested* bytes, not of the session's total tokens — the model's own output and the system prompt are outside what the hook can see. This README quotes no percentage because the number is yours to measure: run a real session with the plugin installed, then `stats.sh --by-session`. Denied bytes are an upper bound (the host would have capped some of them) and tokens are `bytes / 4`; treat both as directional.

**External API mode:**

```bash
npx prompt-sift stats
```

Metrics include calls, cache-hit rate, source bytes, worker tokens when reported by the provider, latency, and estimated primary-context tokens saved. Token savings use a transparent `bytes / 4` estimate; they are directional, not a billing statement.

## Compatibility

| Surface | Status | Notes |
|---|---|---|
| Cursor IDE / CLI | Supported | Project `preToolUse` hook and portable Agent Skill |
| Cursor Cloud Agent | Supported with setup | The package and worker endpoint must be available in the cloud environment |
| Claude Code | Supported with setup | Native Opus/Sonnet agents and PreToolUse hook |
| GitHub Copilot CLI | Supported | Repository hook uses Copilot's native camel-case event contract |
| GitHub Copilot cloud agent | Supported with setup | Install the package in the environment and allow network access to a remote worker, or use hooks only as advisory policy |

The checked-in runner fails open if PromptSift is unavailable, preventing a missing dependency from blocking every read.

## Development

```bash
npm test
npm run check
```

The tests cover native hook schemas, line and byte thresholds, minified files, partial reads, quoted paths, chained shell commands, redirects, pipes, safe fence stripping, and idempotent installation.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not through public issues.

## License

MIT

## Native bulk-reader and code-writer

All three plugin bundles include discoverable `bulk-reader` and `code-writer` skills. No additional setup or external API key is needed. Select the installed skill by its host-displayed name, or ask the agent to use it:

- “Use bulk-reader to find which files own session refresh. Return paths and relevant line ranges.”
- “Use code-writer to create test/user.test.js following test/order.test.js, covering empty input and duplicates.”

The bulk-reader delegates bounded source inspection to the read-only worker. The code-writer delegates predictable generation to a separate native writer: Luna/xhigh on Cursor and Copilot CLI, Sonnet/high on Claude Code. The primary specialist retains Sol/high or Opus/high and reviews the generated file and relevant tests.

The writer requires a specification, existing reference and target. It streams generated code into a bundled POSIX shell helper and returns a short summary instead of the code. The helper rejects missing/empty references, empty output, symlink targets and existing files unless replacement is explicitly requested with `--force`. Destination directories must exist. Output is staged beside the target before publication; files are created with private permissions. This helper has no Node, jq or network dependency.

The helper guards its own writes; agent instructions and host permissions govern other shell operations. It is not a sandbox against a malicious process changing destination directories concurrently. Native model execution still depends on host access and model availability. CI exercises isolated plugin bundles, discovery contracts and script behavior on Linux/macOS; it does not run authenticated model sessions or establish a token-savings percentage. Plugin mode measures context per tool through the `postToolUse` ledger (see Metrics); the worker cache belongs to the optional external CLI mode.
