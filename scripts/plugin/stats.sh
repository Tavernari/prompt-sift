#!/bin/sh
# Summarise the PromptSift ledger: bytes and estimated tokens each tool put into the model's context,
# and what the pre-hook kept out. Usage: stats.sh [--cwd <project>] [--since <ISO-8601>] [--by-session]
set -u
cwd_filter=''; since='1970-01-01T00:00:00Z'; by_session=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd) cwd_filter=${2-}; shift 2 ;;
    --since) since=${2-}; shift 2 ;;
    --by-session) by_session=1; shift ;;
    *) printf 'usage: stats.sh [--cwd <project>] [--since <ISO-8601>] [--by-session]\n' >&2; exit 2 ;;
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
# Shared prelude: the filtered rows and the headline. "Requested" bytes are what the model asked for:
# what entered context plus what a denial kept out. Refusals (a worker's write attempt) carry no size.
prelude='
  def pad(n): tostring | if length >= n then . else " " * (n - length) + . end;
  def lpad(n): tostring | .[0:n] | if length >= n then . else . + " " * (n - length) end;
  def pct(part; whole): if whole == 0 then "0.0%" else (part * 1000 / whole | round) as $r | "\($r / 10 | floor).\($r % 10)%" end;
  map(select(type == "object" and .at >= $since and ($cwd == "" or .cwd == $cwd))) as $rows |
  ($rows | map(select(.event == "result"))) as $results |
  ($rows | map(select(.event == "deny"))) as $denied |
  ($rows | map(select(.event == "refuse"))) as $refused |
  ($results | map(.bytes) | add // 0) as $in |
  ($denied | map(.bytes) | add // 0) as $out |
'
if [ "$by_session" -eq 1 ]; then
  jq -rs --arg cwd "$cwd_filter" --arg since "$since" "$prelude"'
    (if $in == 0 and $out > 0 then "kept out of context: \($out) bytes denied, but no tool results recorded: the postToolUse hook is not running, so the share cannot be measured"
     else "kept out of context: \(pct($out; $in + $out)) of requested bytes across \($rows | map(.session // "-") | unique | length) sessions" end),
    "",
    "session       results   ~tokens in   denials   ~tokens out   kept out",
    ($rows | group_by(.session // "-") | map(
       (map(select(.event == "result"))) as $r | (map(select(.event == "deny"))) as $d |
       {session: (.[0].session // "-"), results: ($r | length), tin: ($r | map(.tokens) | add // 0),
        denials: ($d | length), tout: ($d | map(.tokens) | add // 0),
        share: pct(($d | map(.bytes) | add // 0); ($r | map(.bytes) | add // 0) + ($d | map(.bytes) | add // 0))})
       | sort_by(-.tout, -.tin) | .[] |
       "\(.session | lpad(12))  \(.results | pad(7))  \(.tin | pad(11))  \(.denials | pad(7))  \(.tout | pad(11))  \(.share | pad(8))"),
    "",
    "A session is a cksum of the host conversation id; \"-\" groups rows the host did not key. Tokens are bytes / 4."
  ' "$ledger"
  exit
fi
jq -rs --arg cwd "$cwd_filter" --arg since "$since" "$prelude"'
  (if $in == 0 and $out > 0 then "kept out of context: \($out) bytes denied, but no tool results recorded: the postToolUse hook is not running, so the share cannot be measured"
   else "kept out of context: \(pct($out; $in + $out)) of requested bytes (\($in) entered, \($out) denied)" end),
  "ledger rows: \($rows | length)   results: \($results | length)   denials: \($denied | length)   \($refused | length) worker refusal\(if ($refused | length) == 1 then "" else "s" end)",
  "",
  "tool                          calls        bytes     ~tokens   largest",
  ($results | group_by(.tool) | map({tool: .[0].tool, calls: length, bytes: (map(.bytes) | add),
     tokens: (map(.tokens) | add), largest: (map(.bytes) | max)}) | sort_by(-.bytes) | .[] |
     "\(.tool | lpad(28))  \(.calls | pad(5))  \(.bytes | pad(11))  \(.tokens | pad(10))  \(.largest)"),
  "",
  "into context:  \($in) bytes  ~\($results | map(.tokens) | add // 0) tokens",
  "deferred:      \($denied | length) denials kept ~\($denied | map(.tokens) | add // 0) tokens (\($out) bytes) out of the primary context",
  "",
  "Tokens are bytes / 4: directional, not a bill. Denied bytes are file sizes at deny time, before any host cap."
' "$ledger"
