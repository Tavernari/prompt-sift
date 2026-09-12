# Changelog

## 0.2.0

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
