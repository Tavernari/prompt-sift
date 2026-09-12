#!/bin/sh
# Native writer sink: no LLM, network, jq, or Node dependency.
set -eu
fail() { printf 'prompt-sift writer: %s\n' "$*" >&2; exit 1; }
reference= target= force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reference|--target)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "missing value for $1"
      case "$1" in --reference) reference=$2 ;; --target) target=$2 ;; esac
      shift 2 ;;
    --force) force=1; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ -n "$reference" ] && [ -n "$target" ] || fail 'reference and target are required'
# Prefix relative names so utilities never interpret filenames as options.
case "$reference" in /*) ;; *) reference=./$reference ;; esac
case "$target" in /*) ;; *) target=./$target ;; esac
[ -f "$reference" ] && [ -r "$reference" ] && [ -s "$reference" ] || fail 'reference must be a readable, nonempty file'
[ ! -L "$target" ] || fail 'target must not be a symbolic link'
[ ! -e "$target" ] || { [ "$force" = 1 ] && [ -f "$target" ]; } || fail 'target exists; explicit --force is required for a regular file'
# Staging beside the destination makes publication atomic on the same filesystem.
parent=$(dirname "$target")
[ -d "$parent" ] || fail 'target directory does not exist'
umask 077
staging=$(mktemp "$parent/.prompt-sift-write.XXXXXXXX") || fail 'cannot stage output'
trap 'rm -f "$staging"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$staging"
[ -s "$staging" ] || fail 'refusing empty generated output'
if [ "$force" = 1 ]; then
  # Recheck before replacing; refuse symlinks and non-regular destinations.
  [ ! -L "$target" ] && { [ ! -e "$target" ] || [ -f "$target" ]; } || fail 'invalid replacement target'
  mv -f "$staging" "$target"
else
  # ln publishes exclusively: a concurrently created file is never overwritten.
  # A hard link to the staged inode is safe; the trap removes the staging name.
  ln "$staging" "$target" || fail 'target could not be created exclusively'
fi
printf 'Written: %s\n' "$target"
