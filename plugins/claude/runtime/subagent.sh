#!/bin/sh
# subagentStart hook (Cursor): remembers which subagent ids are PromptSift workers, so hook.sh can
# hold a worker's shell to read-only even though the host's readonly flag does not. Always answers
# {}; a registry that cannot be written only means the guard stays inert for that worker.
host=${1-}
neutral() { printf '%s\n' '{}'; exit 0; }
trap 'neutral' HUP INT TERM
case "$host" in cursor|copilot|claude) ;; *) neutral ;; esac
for utility in head wc dirname tail; do command -v "$utility" >/dev/null 2>&1 || neutral; done
runtime_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || neutral
jq_binary=$(/bin/sh "$runtime_dir/bootstrap-jq.sh" 2>/dev/null) || neutral
jq() { "$jq_binary" "$@"; }
. "$runtime_dir/lib.sh"
payload=$(head -c 1048577) || neutral
[ "$(printf '%s' "$payload" | wc -c)" -le 1048576 ] || neutral
id=$(printf '%s' "$payload" | jq -r --arg host "$host" '
  if type != "object" then error("payload") else . end |
  (.subagent_type // .agent_type // "") as $type |
  if ($type | test("^(prompt-sift:)?prompt-sift-\($host)-worker$")) and ((.subagent_id // .agent_id // "") | test("^[A-Za-z0-9_.:-]{1,128}$"))
  then (.subagent_id // .agent_id) else "" end
' 2>/dev/null) || neutral
[ -n "$id" ] || neutral
registry=$(workers_file) || neutral
( umask 077; mkdir -p -- "$(dirname -- "$registry")" && printf '%s\n' "$id" >> "$registry" ) 2>/dev/null || neutral
# Keep the registry bounded: ids of long-finished workers are of no use.
if [ "$(wc -l < "$registry" 2>/dev/null || printf 0)" -gt 400 ]; then
  ( umask 077; tail -n 200 "$registry" > "$registry.tmp" && mv -f "$registry.tmp" "$registry" ) 2>/dev/null || true
fi
record subagent "$host" "$(printf '%s' "$payload" | jq -r '.cwd // .workspace_roots[0] // ""' 2>/dev/null)" worker 0
neutral
