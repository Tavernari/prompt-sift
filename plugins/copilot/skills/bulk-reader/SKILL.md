---
name: bulk-reader
description: Answer a specific orientation question across several or large source files using a native small-model subagent and a compact source map.
---

Delegate to the discovered `prompt-sift-copilot-worker` agent (the host may prefix it with the plugin name). Pass the question, explicit paths or search scope, and a requested concise answer. Let the worker search and read bounded ranges; do not copy the files into its prompt. Split independent scopes only when needed, avoiding duplicate reads.

Ask for an answer with paths, symbols, line ranges and uncertainties, normally within 500 words. Treat the result as orientation: inspect the cited source before editing or making correctness decisions. Keep architecture, debugging and security judgments in the primary agent. If native delegation is unavailable, use bounded reads directly and disclose that no worker was used; do not silently call an external API.

Never delegate an edit to the worker. It is read-only and must refuse; a worker that is handed a change either fails the task or, worse, applies it through the shell to get around its blocked edit tools. Ask it where the change goes, then make the edit in the parent with the host edit tool. In-place changes are not writer work either: the writer generates whole new files from a reference.
