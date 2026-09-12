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

## Quick start

Prerequisite: Node.js 22 or newer.

Install directly from GitHub:

```bash
npm install --save-dev github:Tavernari/prompt-sift
npx prompt-sift install --host cursor,copilot
```

The default worker is a local Ollama endpoint using `qwen2.5-coder:3b`:

```bash
ollama pull qwen2.5-coder:3b
npx prompt-sift doctor
```

Restart the active agent session after installing hooks.

## What gets installed

| File | Purpose |
|---|---|
| `.prompt-sift.json` | Shared thresholds and worker configuration |
| `.prompt-sift/run-hook.cjs` | Small cross-platform, fail-open hook runner |
| `.cursor/hooks.json` | Cursor `preToolUse` adapter; existing hooks are preserved |
| `.github/hooks/prompt-sift.json` | Copilot `preToolUse` adapter |
| `.agents/skills/prompt-sift/SKILL.md` | Portable routing guidance for agents |
| `.github/instructions/prompt-sift.instructions.md` | Copilot repository instructions |

Running the installer again is idempotent. Existing `.prompt-sift.json` and skill files are kept unless `--force` is passed.

## Use it directly

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
  "provider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5-coder:3b",
    "apiKeyEnv": "PROMPT_SIFT_API_KEY",
    "temperature": 0.2
  }
}
```

Environment variables override the most common settings:

| Variable | Purpose |
|---|---|
| `PROMPT_SIFT_BASE_URL` | OpenAI-compatible `/v1` base URL |
| `PROMPT_SIFT_MODEL` | Worker model identifier |
| `PROMPT_SIFT_API_KEY` | Worker credential; never place it in the JSON file |
| `PROMPT_SIFT_MIN_LINES` | Full-read line threshold |
| `PROMPT_SIFT_MAX_BYTES` | Full-read byte threshold |
| `PROMPT_SIFT_MAX_TARGETED_LINES` | Largest partial read that bypasses delegation |
| `PROMPT_SIFT_TIMEOUT_MS` | Worker request timeout |

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

Source files are sent to the configured worker. Use the local Ollama default when code must remain on your machine, or choose a provider whose data policy you accept.

PromptSift refuses common credential paths such as `.env`, private keys, keystores, and token/secret files. `--allow-sensitive` is an explicit escape hatch, not a recommendation. File contents are wrapped as untrusted data and the worker is told never to follow embedded instructions.

Caches are stored with user-only permissions where supported. Cache and metrics paths are added to `.gitignore` by the installer.

## Metrics

```bash
npx prompt-sift stats
```

Metrics include calls, cache-hit rate, source bytes, worker tokens when reported by the provider, latency, and estimated primary-context tokens saved. Token savings use a transparent `bytes / 4` estimate; they are directional, not a billing statement.

## Compatibility

| Surface | Status | Notes |
|---|---|---|
| Cursor IDE / CLI | Supported | Project `preToolUse` hook and portable Agent Skill |
| Cursor Cloud Agent | Supported with setup | The package and worker endpoint must be available in the cloud environment |
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
