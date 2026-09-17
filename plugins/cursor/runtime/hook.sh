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
deny() {
  result=$(jq -cn --arg host "$host" --arg message "$message" '
  if $host == "cursor" then {permission:"deny",user_message:$message,agent_message:$message}
  elif $host == "copilot" then {permissionDecision:"deny",permissionDecisionReason:$message}
  else {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$message}} end
') || unavailable
  printf '%s\n' "$result"
  exit 0
}
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
   agent: (.agent_type // ""), conversation: (.conversation_id // ""),
   session: ((.conversation_id // .session_id // .sessionId // "") | tostring),
   search: (if $a | has("pattern") then {mode: ($a.output_mode // null), head: ($a.head_limit // null)} else null end),
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
# Lines of text a readable text file holds, counting a last line without newline; 0 for anything else.
text_lines() {
  candidate=$1
  case "$candidate" in /*) ;; *) candidate=./$candidate ;; esac
  [ -f "$candidate" ] && [ -r "$candidate" ] || { printf 0; return; }
  is_binary "$candidate" && { printf 0; return; }
  awk 'END { print NR }' < "$candidate" 2>/dev/null || printf 0
}
# Globs are expanded here, never by running the command: a pattern that matches nothing stays literal.
expand_glob() {
  case "$1" in
    *[\*\?\[]*) set +f; IFS='
'; for match in $1; do [ -e "$match" ] && printf '%s\n' "$match"; done; set -f; unset IFS ;;
    *) printf '%s\n' "$1" ;;
  esac
}
# git diff/show sized with --numstat: read-only, no pager, no index lock, and never the inspected command.
git_changed_lines() {
  command -v git >/dev/null 2>&1 || return 1
  IFS=$(printf '\001'); set -f; set -- $1; unset IFS
  subcommand=$1; shift
  if [ "$subcommand" = show ]; then set -- --format= "$@"; fi
  GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.pager=cat "$subcommand" --numstat --no-ext-diff --no-color "$@" 2>/dev/null |
    awk -F'\t' '$1 ~ /^[0-9]+$/ { n += $1 + $2 } END { print n + 0 }'
}
# Reads the recognizer's lines and prints one finding "<kind><TAB><description>" or nothing.
# Parts are summed: three 200-line files in one cat are a 600-line read, and so is a glob.
shell_findings() {
  sum_lines=0; sum_bytes=0; names=""; pattern=""; part_count=0
  flush() {
    if [ "$sum_lines" -gt "$min_lines" ] || [ "$sum_bytes" -gt "$max_bytes" ]; then
      if [ -n "$pattern" ]; then printf 'sum\t%s (%s files, %s lines together)' "$pattern" "$part_count" "$sum_lines"
      else printf 'sum\t%s together (%s lines)' "$names" "$sum_lines"; fi
      exit 0
    fi
    sum_lines=0; sum_bytes=0; names=""; pattern=""; part_count=0
  }
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
      "!part	"*) flush ;;
      "!unbounded	"*) printf 'unbounded\t%s' "${entry#*	}"; exit 0 ;;
      "!git	"*)
        changed=$(git_changed_lines "${entry#*	}") || continue
        if [ "${changed:-0}" -gt "$min_lines" ]; then
          printf 'diff\tgit %s: %s changed lines' "$(printf '%s' "${entry#*	}" | tr '\001' ' ')" "$changed"; exit 0
        fi ;;
      *)
        case "$entry" in *[\*\?\[]*) pattern=$entry ;; esac
        expanded=$(expand_glob "$entry")
        [ -n "$expanded" ] || continue
        large=$(printf '%s\n' "$expanded" | while IFS= read -r match; do
          if is_large "$match"; then printf '%s' "$match"; break; fi
        done)
        if [ -n "$large" ]; then printf 'large\t%s' "$large"; exit 0; fi
        lines_here=$(printf '%s\n' "$expanded" | while IFS= read -r match; do text_lines "$match"; printf '\n'; done | awk '{ n += $1 } END { print n + 0 }')
        bytes_here=$(printf '%s\n' "$expanded" | while IFS= read -r match; do
          case "$match" in /*) ;; *) match=./$match ;; esac
          [ -f "$match" ] && [ -r "$match" ] && ! is_binary "$match" && wc -c < "$match" 2>/dev/null || printf 0; printf '\n'
        done | awk '{ n += $1 } END { print n + 0 }')
        count_here=$(printf '%s\n' "$expanded" | awk 'NF { n++ } END { print n + 0 }')
        sum_lines=$((sum_lines + lines_here)); sum_bytes=$((sum_bytes + bytes_here)); part_count=$((part_count + count_here))
        [ -n "$pattern" ] || names="${names:+$names, }$entry" ;;
    esac
  done
  flush
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
    # A PromptSift worker is read-only by contract; where the host says who is calling, the hook
    # holds its shell to searching and reading. The redirect must be flagged when the worker's
    # own readonly flag cannot: it stopped the edit tools and the worker reached for the shell.
    if is_worker "$host" "$(printf '%s' "$normalized" | jq -r '.agent')" "$(printf '%s' "$normalized" | jq -r '.conversation')"; then
      verdict=$(printf '%s' "$normalized" | jq -r '.command' | awk -v classify=1 -f "$runtime_dir/shell-paths.awk") || unavailable
      if [ "$verdict" = write ]; then
        record refuse "$host" "$cwd" "$tool" 0
        message="PromptSift: prompt-sift-$host-worker is read-only and this shell command would change the workspace. Do not work around it with redirection, heredocs, tee, sed -i, patch or git; return the orientation you already have (paths, symbols, line ranges) to the parent, which makes the edit itself."
        deny
      fi
    fi
    candidates=$(printf '%s' "$normalized" | jq -r '.command' | awk -v max_lines="$max_targeted" -v max_bytes="$max_bytes" -f "$runtime_dir/shell-paths.awk") || unavailable
    finding=$(printf '%s\n' "$candidates" | shell_findings)
    [ -n "$finding" ] || allow
    kind=${finding%%	*}
    file=${finding#*	}
    ;;
  grep|rg)
    # Only what can be measured is gated: a content-mode search of one large file with no bound
    # under max_targeted is that file's read in disguise. Directory searches are the host's own
    # cap to enforce, except an explicit head_limit of 0, which Claude Code treats as unlimited.
    verdict=$(printf '%s' "$normalized" | jq -r --arg host "$host" --argjson maximum "$max_targeted" '
      .search as $s |
      if $s == null then "allow" else
      ($s.mode // (if $host == "claude" then "files_with_matches" else "content" end)) as $mode |
      if $mode != "content" then "allow"
      elif ($s.head | type) == "number" and $s.head > 0 and $s.head <= $maximum and ($s.head | floor) == $s.head then "allow"
      elif ($s.head | type) == "number" and $s.head == 0 and $host == "claude" then "unbounded"
      else "measure" end end
    ') || unavailable
    [ "$verdict" != allow ] || allow
    file=$(printf '%s' "$normalized" | jq -r '.path') || unavailable
    if [ "$verdict" = measure ]; then
      [ -n "$file" ] || allow
      is_large "$file" || allow
    fi
    [ -n "$file" ] || file="the workspace"
    ;;
  *) allow ;;
esac
# Ledger row for the denial: size on disk is what would have entered the context, before any host cap.
record deny "$host" "$cwd" "$tool" "$(wc -c < "$file" 2>/dev/null || printf 0)" "" "$(session_key "$host" "$(printf '%s' "$normalized" | jq -r '.session')" "$cwd")"
case "$tool:${kind-}" in
  grep:*|rg:*) message="PromptSift blocked an unbounded content search of $file. Use output_mode files_with_matches or count, a head_limit of at most $max_targeted, a narrower path, or delegate orientation to prompt-sift:prompt-sift-$host-worker." ;;
  *:unbounded) message="PromptSift blocked an unbounded dump: $file. Bound it (a count, a path, a pipe into head or grep) or delegate orientation to prompt-sift:prompt-sift-$host-worker." ;;
  *:diff) message="PromptSift blocked $file, more than $min_lines. Start with --stat, then diff one path, or delegate the review to prompt-sift:prompt-sift-$host-worker." ;;
  *:sum) message="PromptSift blocked a read of $file. Read one file at a time with bounded ranges of at most $max_targeted lines, or delegate orientation to prompt-sift:prompt-sift-$host-worker." ;;
  *) message="PromptSift blocked a broad read of $file. Delegate orientation to prompt-sift:prompt-sift-$host-worker; use bounded reads of at most $max_targeted lines and return a concise summary. Use prompt-sift:prompt-sift-$host-primary for complex reasoning. For debugging, security, concurrency, architecture or edits, use search plus a targeted read." ;;
esac
deny
