# External API mode (legacy)

This is the original PromptSift: a Node.js CLI that sends selected files to an OpenAI-compatible worker and returns a summary, plus a project-local installer that writes hooks and agents into the repository. It still works and is still tested, but the plugin bundles are the supported path: they need no npm, no API key and no project files, and they enforce the same policy through the host's own hooks. Use this mode when you want a worker outside your host's model access (a local Ollama, a different provider) or project-local files you can edit.

Use either plugin mode or project-local hooks for a given host, never both.

## npm installation

Node.js 22+ is required:

```bash
npm install --save-dev github:Tavernari/prompt-sift
npx prompt-sift install --host all
```

Existing npm installations should remove only their PromptSift hook entries before switching to plugins, and preserve unrelated hooks.

## What the installer writes

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

## The external worker

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

## Security

Native subagents process files through your host provider. Direct CLI commands send selected files to the configured external worker; its default endpoint is OpenAI. Configure a local Ollama endpoint when code must remain on your machine.

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
| Claude Code | Supported with setup | Native Opus/Sonnet agents and PreToolUse hook |
| GitHub Copilot CLI | Supported | Repository hook uses Copilot's native camel-case event contract |
| GitHub Copilot cloud agent | Supported with setup | Install the package in the environment and allow network access to a remote worker, or use hooks only as advisory policy |

The checked-in runner fails open if PromptSift is unavailable, preventing a missing dependency from blocking every read.
