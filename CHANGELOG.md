# Changelog

## Unreleased

- Never gate binary files: an image or PDF above `maxBytes` was denied with "use bounded reads" on every host, and the worker it pointed to was denied the same way.
- Record a `postToolUse` ledger in plugin mode (bytes and estimated tokens per tool result, denials included; no paths or contents), add one short reminder when a single result exceeds `maxBytes`, and ship `runtime/stats.sh` plus a `context-stats` skill to read it. `PROMPT_SIFT_TELEMETRY=0` and `PROMPT_SIFT_NUDGE=0` opt out.

## 0.4.0

- Add native code-writer agents for Cursor, Copilot CLI and Claude Code.
- Bundle explicit bulk-reader and code-writer skills with plugins and the optional installer.
- Require a reference and guard generated output with a dependency-free shell writer.
- Exercise writer failures, overwrite protection and isolated plugin execution in Linux/macOS CI.

## 0.3.0

- Automatically install missing jq into a user cache with pinned version and SHA-256 verification, without sudo; reuse verified binaries and fail open on download errors.

- Replace bundled Node plugin hooks with POSIX shell, jq and awk for macOS/Linux.
- Remove copied JavaScript runtimes and Windows PowerShell plugin launchers.
- Run plugin CI on macOS and Linux, including enforcement with Node absent from PATH.
- Preserve native schemas, bounded reads, thresholds, safe quoting and fail-open behavior.

## 0.2.0

- Recognize Copilot view_range and JSON-encoded tool arguments so bounded native worker reads are allowed.

- Ship self-contained plugin bundles and host-specific marketplaces for Cursor, Copilot CLI and Claude Code.
- Run hooks from plugin cache without npm, external credentials or project initialization.
- Test isolated plugin copies, missing runtimes, malformed input and packaged-source drift; add Windows PowerShell CI.

- Install native primary/worker agents for Cursor (Sol/high and Luna/xhigh), Copilot (required models with explicit effort), and Claude Code (Opus/high and Sonnet/high).
- Add Claude Code hooks with native nested decisions and neutral fail-open output.
- Guide native workers through bounded reads to avoid recursive hook delegation.

- Default to OpenAI GPT-5.6 Luna with xhigh reasoning for worker requests and record GPT-5.6 Sol/high as the primary-agent preference.
- Send reasoning parameters and separate cache entries by reasoning settings.
- Preserve explicit local-worker configurations.

All notable user-visible changes are recorded here.

The project follows Semantic Versioning once stable releases begin. During `0.x`, minor versions may include breaking changes when clearly documented.

## 0.2.0

- Recognize Copilot view_range and JSON-encoded tool arguments so bounded native worker reads are allowed.

- Ship self-contained plugin bundles and host-specific marketplaces for Cursor, Copilot CLI and Claude Code.
- Run hooks from plugin cache without npm, external credentials or project initialization.
- Test isolated plugin copies, missing runtimes, malformed input and packaged-source drift; add Windows PowerShell CI.

- Install native primary/worker agents for Cursor (Sol/high and Luna/xhigh), Copilot (required models with explicit effort), and Claude Code (Opus/high and Sonnet/high).
- Add Claude Code hooks with native nested decisions and neutral fail-open output.
- Guide native workers through bounded reads to avoid recursive hook delegation.

### Added

- Open-source community health files and contribution workflow.
- Stable required CI check across supported Node.js versions.
- Installed-runner end-to-end coverage for Cursor and GitHub Copilot.

## 0.1.0 - 2026-09-12

### Added

- Cursor and GitHub Copilot `preToolUse` adapters.
- Line- and byte-aware broad-read policy.
- OpenAI-compatible worker transport with local Ollama defaults.
- Exact content-addressed cache and local metrics.
- Protected, reference-based direct-to-disk generation.
- Cross-platform installer, diagnostics, tests, and benchmark.
