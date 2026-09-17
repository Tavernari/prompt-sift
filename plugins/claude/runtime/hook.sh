#!/bin/sh
# POSIX shell hook. jq parses JSON; payloads and commands are never evaluated.
host=${1-}
allow() {
  case "$host" in
    cursor) printf '%s\n' '{"permission":"allow"}' ;;
    copilot) printf '%s\n' '{"permissionDecision":"allow"}' ;;
    *) printf '%s\n' '{}' ;;
  esac
  exit 0
}
unavailable() {
  printf '%s\n' 'PromptSift: hook unavailable; native agents remain active, read enforcement is inactive.' >&2
  allow
}
trap 'unavailable' HUP INT TERM
case "$host" in cursor|copilot|claude) ;; *) allow ;; esac
for utility in awk wc head tr dirname; do
  command -v "$utility" >/dev/null 2>&1 || {
    printf 'PromptSift: %s unavailable; native agents remain active, read enforcement is inactive.\n' "$utility" >&2
    allow
  }
done
runtime_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || unavailable
jq_binary=$(/bin/sh "$runtime_dir/bootstrap-jq.sh") || unavailable
jq() { "$jq_binary" "$@"; }
payload=$(head -c 1048577) || unavailable
[ "$(printf '%s' "$payload" | wc -c)" -le 1048576 ] || unavailable
# Control characters in paths cannot safely be represented by line-oriented shell utilities.
# Reject those payloads rather than silently changing the path.
normalized=$(printf '%s' "$payload" | jq -ce '
  def clean: type == "string" and (test("[\u0000-\u001f]") | not);
  if type != "object" then error("payload") else . end |
  (.toolArgs // .tool_input // {}) as $raw |
  ($raw | if type == "string" then fromjson else . end) as $a |
  if ($a | type) != "object" then error("arguments") else . end |
  {cwd: (.cwd // .workspace_roots[0] // ""),
   tool: ((.toolName // .tool_name // "") | ascii_downcase),
   path: ($a.path // $a.file_path // $a.filePath // ""),
   command: ($a.command // $a.cmd // $a.script // ""),
   limit: (if $a | has("view_range") then
     $a.view_range as $r | if ($r|type) == "array" and ($r|length) == 2 and
       ($r[0]|type) == "number" and ($r[1]|type) == "number" and
       $r[0] >= 1 and $r[1] >= $r[0] and ($r[0]|floor) == $r[0] and ($r[1]|floor) == $r[1]
       then $r[1] - $r[0] + 1 else null end
     else (($a.limit // $a.line_limit // $a.lineLimit // null) | try tonumber catch null) end)} |
  if (.cwd|clean) and (.path|clean) and (.command|type) == "string" then . else error("path") end
' 2>/dev/null) || unavailable
[ -n "$normalized" ] || unavailable
cwd=$(printf '%s' "$normalized" | jq -r '.cwd') || unavailable
[ -z "$cwd" ] || cd -- "$cwd" || unavailable
. "$runtime_dir/lib.sh"
read_limits || unavailable
is_binary() {
  sample=$(head -c 8192 "$1" 2>/dev/null | wc -c) || return 1
  stripped=$(head -c 8192 "$1" 2>/dev/null | tr -d '\000' | wc -c) || return 1
  [ "$sample" -ne "$stripped" ]
}
is_large() {
  candidate=$1
  case "$candidate" in /*) ;; *) candidate=./$candidate ;; esac
  [ -f "$candidate" ] && [ -r "$candidate" ] || return 1
  bytes=$(wc -c < "$candidate" 2>/dev/null) || return 1
  # Binary files (NUL in the first 8 KiB) are rendered by the host itself; a worker cannot
  # summarise an image, so the text gate must never fire on them.
  is_binary "$candidate" && return 1
  [ "$bytes" -gt "$max_bytes" ] && return 0
  # awk counts the last line even when the file has no trailing newline.
  lines=$(awk -v ceiling="$min_lines" 'NR > ceiling { print NR; exit } END { if (NR <= ceiling) print NR }' < "$candidate" 2>/dev/null) || return 1
  [ "$lines" -gt "$min_lines" ]
}
tool=$(printf '%s' "$normalized" | jq -r '.tool') || unavailable
case "$tool" in
  read|view)
    limit=$(printf '%s' "$normalized" | jq -r '.limit // 0') || unavailable
    targeted=$(printf '%s' "$limit" | jq -r --argjson maximum "$max_targeted" '. > 0 and . <= $maximum and floor == .') || unavailable
    [ "$targeted" = true ] && allow
    file=$(printf '%s' "$normalized" | jq -r '.path') || unavailable
    [ -n "$file" ] || allow
    is_large "$file" || allow
    ;;
  shell|bash)
    [ -r "$runtime_dir/shell-paths.awk" ] || unavailable
    candidates=$(printf '%s' "$normalized" | jq -r '.command' | awk -v max_lines="$max_targeted" -v max_bytes="$max_bytes" -f "$runtime_dir/shell-paths.awk") || unavailable
    file=$(printf '%s\n' "$candidates" | while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      if is_large "$entry"; then printf '%s' "$entry"; break; fi
    done)
    [ -n "$file" ] || allow
    ;;
  *) allow ;;
esac
# Ledger row for the denial: size on disk is what would have entered the context, before any host cap.
record deny "$host" "$cwd" "$tool" "$(wc -c < "$file" 2>/dev/null || printf 0)"
message="PromptSift blocked a broad read of $file. Delegate orientation to prompt-sift:prompt-sift-$host-worker; use bounded reads of at most $max_targeted lines and return a concise summary. Use prompt-sift:prompt-sift-$host-primary for complex reasoning. For debugging, security, concurrency, architecture or edits, use search plus a targeted read."
result=$(jq -cn --arg host "$host" --arg message "$message" '
  if $host == "cursor" then {permission:"deny",user_message:$message,agent_message:$message}
  elif $host == "copilot" then {permissionDecision:"deny",permissionDecisionReason:$message}
  else {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$message}} end
') || unavailable
printf '%s\n' "$result"
exit 0
