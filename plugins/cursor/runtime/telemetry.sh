#!/bin/sh
# postToolUse ledger: records how many bytes each tool result put into the model's context.
# It never blocks, never rewrites a result and never stores contents or paths; it answers {} unless
# a single result exceeded maxBytes, in which case it adds one short line of context.
host=${1-}
neutral() { printf '%s\n' '{}'; exit 0; }
trap 'neutral' HUP INT TERM
[ "${PROMPT_SIFT_TELEMETRY-1}" != 0 ] || neutral
case "$host" in cursor|copilot|claude) ;; *) neutral ;; esac
for utility in head wc dirname awk; do command -v "$utility" >/dev/null 2>&1 || neutral; done
runtime_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || neutral
jq_binary=$(/bin/sh "$runtime_dir/bootstrap-jq.sh" 2>/dev/null) || neutral
jq() { "$jq_binary" "$@"; }
. "$runtime_dir/lib.sh"
# Results can be large; 16 MiB covers any inline tool output and bounds the hook's own memory.
payload=$(head -c 16777217) || neutral
[ "$(printf '%s' "$payload" | wc -c)" -le 16777216 ] || neutral
summary=$(printf '%s' "$payload" | jq -cr '
  if type != "object" then error("payload") else . end |
  (.tool_output // .toolResult.textResultForLlm // .tool_result.text_result_for_llm // .tool_response // "") as $out |
  [(.cwd // .workspace_roots[0] // ""),
   ((.toolName // .tool_name // "") | ascii_downcase),
   ((.conversation_id // .session_id // .sessionId // "") | tostring | if . == "" then "-" else . end),
   ($out | if type == "string" then utf8bytelength else tojson | utf8bytelength end),
   ((.duration // .duration_ms // "") | if type == "number" then floor else "" end)] | @tsv
' 2>/dev/null) || neutral
[ -n "$summary" ] || neutral
tab=$(printf '\t')
IFS="$tab" read -r cwd tool session_id bytes ms <<EOF_SUMMARY
$summary
EOF_SUMMARY
# "-" is jq's stand-in for "no session": a tab-separated empty field would collapse under read.
[ "$session_id" != - ] || session_id=""
session=$(session_key "$host" "$session_id" "$cwd")
record result "$host" "$cwd" "$tool" "$bytes" "$ms" "$session"
[ "${PROMPT_SIFT_NUDGE-1}" != 0 ] || neutral
[ -z "$cwd" ] || cd -- "$cwd" 2>/dev/null || neutral
read_limits || neutral
[ "$bytes" -gt "$max_bytes" ] || neutral
# The nudge escalates: the first names the size, the second the running total, the third
# and later tell the agent exactly what to do instead. The tally is per session.
tally=$(nudge_count "$session" $(( (bytes + 3) / 4 ))) || tally="1 $(( (bytes + 3) / 4 ))"
set -- $tally
jq -cn --arg host "$host" --arg tool "$tool" --argjson bytes "$bytes" --argjson count "${1:-1}" --argjson total "${2:-0}" '
  ($bytes / 1024 * 10 | round / 10) as $kb | (($bytes + 3) / 4 | floor) as $tokens |
  ($count | if . % 100 >= 11 and . % 100 <= 13 then "th" elif . % 10 == 1 then "st" elif . % 10 == 2 then "nd" elif . % 10 == 3 then "rd" else "th" end) as $suffix |
  (if $count <= 1 then
    "PromptSift: that \($tool) result was \($kb) KB (~\($tokens) tokens of context). Narrow the request (a bounded read, head_limit, a tighter query) or delegate orientation to prompt-sift-\($host)-worker."
  elif $count == 2 then
    "PromptSift: second oversized result this session; that \($tool) result was \($kb) KB, ~\($total) tokens of context over the limit so far. Narrow the request (a bounded read, head_limit, a tighter query) or delegate orientation to prompt-sift-\($host)-worker."
  else
    "PromptSift: \($count)\($suffix) oversized result this session (~\($total) tokens of context). Stop reading directly: hand the next orientation question to prompt-sift-\($host)-worker; call it with the question and the paths, and ask for a summary under 500 words."
  end) as $m |
  if $host == "cursor" then {additional_context: $m}
  elif $host == "copilot" then {additionalContext: $m}
  else {hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}} end
' 2>/dev/null || neutral
exit 0
