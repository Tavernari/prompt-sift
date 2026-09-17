# Sourced by hook.sh and telemetry.sh after jq() is defined. POSIX sh only.
# Every function here is fail-open: a ledger that cannot be written never changes a decision.
cache_root() {
  if [ -n "${XDG_CACHE_HOME-}" ]; then printf '%s' "$XDG_CACHE_HOME"
  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then printf '%s' "${HOME:?}/Library/Caches"
  else printf '%s' "${HOME:?}/.cache"; fi
}
metrics_file() {
  if [ -n "${PROMPT_SIFT_METRICS_FILE-}" ]; then printf '%s' "$PROMPT_SIFT_METRICS_FILE"
  else printf '%s/prompt-sift/metrics.jsonl' "$(cache_root)"; fi
}
workers_file() { printf '%s/prompt-sift/workers' "$(cache_root)"; }
# is_worker <host> <agent_type> <conversation_id>: Claude Code names the subagent on every hook call;
# Cursor only at subagentStart, so its ids are looked up in the registry subagent.sh keeps.
is_worker() {
  case "$2" in "prompt-sift-$1-worker"|"prompt-sift:prompt-sift-$1-worker") return 0 ;; esac
  [ -n "$3" ] || return 1
  registry=$(workers_file) || return 1
  [ -r "$registry" ] || return 1
  awk -v id="$3" '$0 == id { found = 1; exit } END { exit !found }' "$registry" 2>/dev/null
}
# record <event> <host> <cwd> <tool> <bytes> [<ms>]: one JSON line, private permissions, no paths or contents.
record() {
  [ "${PROMPT_SIFT_TELEMETRY-1}" != 0 ] || return 0
  ledger=$(metrics_file) || return 0
  row=$(jq -cn --arg event "$1" --arg host "$2" --arg cwd "$3" --arg tool "$4" --arg bytes "$5" --arg ms "${6-}" '
    ($bytes | tonumber) as $b |
    {at: (now | todate), host: $host, cwd: $cwd, event: $event, tool: $tool, bytes: $b,
     tokens: (($b + 3) / 4 | floor), ms: ($ms | if . == "" then null else tonumber end)}
  ' 2>/dev/null) || return 0
  ( umask 077; mkdir -p -- "$(dirname -- "$ledger")" && printf '%s\n' "$row" >> "$ledger" ) 2>/dev/null || true
}
# read_limits: sets min_lines / max_bytes / max_targeted from env or ./.prompt-sift.json; non-zero when invalid.
read_limits() {
  config='{}'
  if [ -e .prompt-sift.json ]; then
    config=$(head -c 1048577 .prompt-sift.json) || return 1
    [ "$(printf '%s' "$config" | wc -c)" -le 1048576 ] || return 1
  fi
  limits=$(printf '%s' "$config" | jq -er '
    def positive: tonumber | if . > 0 and . <= 2147483647 and floor == . then . else error("limit") end;
    if type != "object" then error("config") else . end |
    [(env.PROMPT_SIFT_MIN_LINES // .minLines // 350 | positive),
     (env.PROMPT_SIFT_MAX_BYTES // .maxBytes // 50000 | positive),
     (env.PROMPT_SIFT_MAX_TARGETED_LINES // .maxTargetedLines // 350 | positive)] | @tsv
  ' 2>/dev/null) || return 1
  # Values have been validated as bounded positive integers; no pathname expansion.
  set -f
  set -- $limits
  [ "$#" -eq 3 ] || return 1
  min_lines=$1
  max_bytes=$2
  max_targeted=$3
}
