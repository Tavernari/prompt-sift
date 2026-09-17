# Changelog

## Unreleased

- The README now leads with the plugins: install, what the hook denies and why, the worker contract, the escalating reminder and how to measure the saving, in about a hundred lines. The npm installer and the external API worker (`read`, `write`, `inspect`, `stats`) are documented as legacy in `docs/EXTERNAL_API_MODE.md`, still tested and still useful for a worker outside the host's model access; `prompt-sift --help` says the same and lists the plugin install first.

- `stats.sh` opens with a headline, "kept out of context: N% of requested bytes", where requested is what entered context plus what denials kept out, and `--by-session` breaks it down per conversation using the new `session` field. Denials with no results are reported as "the postToolUse hook is not running", never as a 100% saving. The README's Measuring section describes the method and quotes no percentage: the number is measured per installation, not claimed.

- The oversized-result reminder escalates per session instead of repeating itself. Ledger rows now carry a `session` field, a `cksum` of the host's conversation id (never the id itself); the first oversized result gets the short reminder, the second states the running total of tokens over the limit, and the third and later name `prompt-sift-<host>-worker` and how to call it. The tally lives next to the ledger and is dropped with it; without `cksum` the key is empty and only the escalation is lost.

- The shell recognizer now knows the dumpers that lost the most context while it looked at one path at a time. Files in one `cat` are summed (three 200-line files are a 600-line read) and globs are expanded by the hook, never by running the command. `git log -p` with no count is denied as unbounded; `git diff` and `git show` are sized with `git --numstat` (read-only, no pager, no index lock) and denied above `minLines` unless a summary flag, a pipe into a reducer or a blob path bounds them; `find ... -exec cat` and `xargs cat` are denied unless reduced. Same rules in `hook.sh` and in the installed JS policy.

- A worker's shell is read-only where the host says who is calling. Cursor's `subagentStart` hook (`runtime/subagent.sh`) registers PromptSift worker ids; the `preToolUse` hook then classifies a worker's shell command and denies anything that could change the workspace (redirection, heredocs, `tee`, `sed -i`, `patch`, `git` write subcommands, builds, package managers, unknown commands, command substitution) while search and read commands pass. Claude Code carries `agent_type` on every call, so no registry is needed there. Copilot exposes no caller identity: its worker is protected by its `tools` list alone. Refusals are ledger rows (`event: refuse`).


- The orientation worker now runs at `low` reasoning effort on every host (Cursor `gpt-5.6-luna[effort=low]`, Copilot `reasoningEffort: low`, Claude Code Sonnet `effort: low`), and the external CLI worker defaults to `low` as well. Search plus a bounded read plus a summary does not need `xhigh`, and at `xhigh` the "cheap" worker could out-cost the parent session. The writer keeps `xhigh`.

- Worker contracts now refuse delegated edits explicitly and forbid the shell workaround (redirection, heredocs, `tee`, `sed -i`, `patch`, `git apply`). In a live Cursor session the read-only worker, handed an edit, wrote "Applying edits via shell since file edit tools are blocked" and modified four files: Cursor's `readonly` only blocked the edit tools. The primary agents, the bulk-reader skill and the Cursor routing rule now say edits stay in the parent; `test/agent-contracts.test.js` pins all of it.

- Grep is routed through the hook on all three hosts. A content-mode search of one large file with no bound under `maxTargetedLines` is denied like a read of that file; `files_with_matches`, `count`, bounded `head_limit` and directory searches pass. Claude Code's `head_limit: 0` (unlimited) is denied even without a path. Before this, Grep never reached the hook on any host.

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
