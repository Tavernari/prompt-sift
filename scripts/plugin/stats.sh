#!/bin/sh
# Summarise the PromptSift ledger: bytes and estimated tokens each tool put into the model's context,
# and what the pre-hook kept out. Usage: stats.sh [--cwd <project>] [--since <ISO-8601>]
set -u
cwd_filter=''; since='1970-01-01T00:00:00Z'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd) cwd_filter=${2-}; shift 2 ;;
    --since) since=${2-}; shift 2 ;;
    *) printf 'usage: stats.sh [--cwd <project>] [--since <ISO-8601>]\n' >&2; exit 2 ;;
  esac
done
runtime_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
jq_binary=$(/bin/sh "$runtime_dir/bootstrap-jq.sh") || exit 1
jq() { "$jq_binary" "$@"; }
. "$runtime_dir/lib.sh"
ledger=$(metrics_file)
if [ ! -s "$ledger" ]; then
  printf 'PromptSift: no tool results recorded yet (ledger: %s).\n' "$ledger"
  exit 0
fi
jq -rs --arg cwd "$cwd_filter" --arg since "$since" '
  map(select(type == "object" and .at >= $since and ($cwd == "" or .cwd == $cwd))) as $rows |
  ($rows | map(select(.event == "result"))) as $results |
  ($rows | map(select(.event == "deny"))) as $denied |
  "ledger rows: \($rows | length)   results: \($results | length)   denials: \($denied | length)",
  "",
  "tool                          calls        bytes     ~tokens   largest",
  ($results | group_by(.tool) | map({tool: .[0].tool, calls: length, bytes: (map(.bytes) | add),
     tokens: (map(.tokens) | add), largest: (map(.bytes) | max)}) | sort_by(-.bytes) | .[] |
     "\(.tool | .[0:28] | . + " " * (28 - length))  \(.calls | tostring | " " * (5 - length) + .)  \(.bytes | tostring | " " * (11 - length) + .)  \(.tokens | tostring | " " * (10 - length) + .)  \(.largest)"),
  "",
  "into context:  \($results | map(.bytes) | add // 0) bytes  ~\($results | map(.tokens) | add // 0) tokens",
  "deferred:      \($denied | length) denials kept ~\($denied | map(.tokens) | add // 0) tokens (\($denied | map(.bytes) | add // 0) bytes) out of the primary context",
  "",
  "Tokens are bytes / 4: directional, not a bill. Denied bytes are file sizes at deny time, before any host cap."
' "$ledger"
