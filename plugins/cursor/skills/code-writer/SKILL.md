---
name: code-writer
description: Generate a predictable source file, test, fixture or configuration from an existing reference using a native small-model writer, without returning the full code to the parent.
---

Use for well-specified generation matching an existing pattern. Keep architecture, security-sensitive logic, debugging and final correctness in the primary agent.

Delegate to the discovered `prompt-sift-cursor-writer` agent (the host may prefix it with the plugin name). Pass the specification, existing reference path, target path, project working directory and the absolute path to `scripts/write-file.sh` inside this skill directory. Resolve that path from this loaded skill's location, not from the project or a guessed cache path. Do not paste source files into the delegation prompt.

A reference and target are required. Include `--force` only when the user's request explicitly intends replacement of that target. Otherwise generate a new file. The helper requires an existing destination directory; create a directory only if the task needs it.

The writer saves code through the helper and returns only the target, a brief change summary and validation status. Review the resulting diff (or the new file when untracked) and run relevant checks before accepting it. A successful write does not prove correctness. If the subagent or helper cannot run, report that limitation; do not switch to an external API or bypass an overwrite refusal.
