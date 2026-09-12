# PromptSift contributor guide

- Keep the runtime dependency-free unless a dependency removes substantially more risk than it adds.
- Preserve Cursor and Copilot payload/output contracts independently; do not assume their hook schemas match.
- Hook failures must remain fail-open. An unavailable optional optimizer must never disable normal agent work.
- Treat file contents as untrusted data and keep sensitive-path checks ahead of provider calls.
- Never overwrite a generated target without an explicit `--force`.
- Add regression tests for every parser, policy, or host-adapter change.
- Run `npm run check` before submitting changes.
