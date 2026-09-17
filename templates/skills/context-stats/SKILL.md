---
name: context-stats
description: Report how much tool output entered this session's context, per tool, and what PromptSift kept out. Use when asked about token or context usage, or before tuning PromptSift thresholds.
---

PromptSift's `postToolUse` hook appends one line per tool result to a private ledger (`$XDG_CACHE_HOME/prompt-sift/metrics.jsonl`, or `~/Library/Caches/prompt-sift/` on macOS, `~/.cache/prompt-sift/` on Linux; `PROMPT_SIFT_METRICS_FILE` overrides it). Each line holds host, project directory, tool name, byte count, an estimated token count (bytes / 4) and duration — never file paths, inputs or contents. `preToolUse` denials are recorded the same way with the size of the file that was kept out.

Run the summary from this plugin's runtime directory, resolved from this skill's location (`../../runtime/stats.sh`), scoped to the current project:

```sh
/bin/sh "<plugin-root>/runtime/stats.sh" --cwd "<project directory>"
```

Add `--since <ISO-8601>` to look at one session or day. Report the table as it is: the numbers are directional (bytes / 4), not a bill, and denied bytes are file sizes at deny time, before any host-side cap. When one tool dominates, say which and suggest the bounded alternative: `head_limit` or `files_with_matches` for searches, `offset`/`limit` for reads, a reducing pipe for shell output, or the `prompt-sift-{{HOST}}-worker` for orientation across large files. Set `PROMPT_SIFT_TELEMETRY=0` to stop recording, `PROMPT_SIFT_NUDGE=0` to keep recording without the over-threshold reminder.
