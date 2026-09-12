#!/bin/sh
# Install a pinned jq binary into a user cache. Never modifies PATH or system packages.
set -eu
umask 077
version=1.8.2
if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1; then
  command -v jq
  exit 0
fi
[ "${PROMPT_SIFT_AUTO_INSTALL-1}" != 0 ] || exit 1
platform=$(uname -s)
architecture=$(uname -m)
case "$platform/$architecture" in
  Linux/x86_64) asset=jq-linux-amd64; checksum=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f ;;
  Linux/aarch64|Linux/arm64) asset=jq-linux-arm64; checksum=8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309 ;;
  Darwin/x86_64) asset=jq-macos-amd64; checksum=e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0 ;;
  Darwin/arm64) asset=jq-macos-arm64; checksum=2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e ;;
  *) printf '%s\n' 'PromptSift: automatic jq installation does not support this platform.' >&2; exit 1 ;;
esac
# Digests are pinned from the official jq-1.8.2 release asset metadata.
verify() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || return 1
  else return 1
  fi
  digest=${digest%% *}
  [ "$digest" = "$checksum" ]
}
if [ -n "${XDG_CACHE_HOME-}" ]; then
  cache_root=$XDG_CACHE_HOME
elif [ "$platform" = Darwin ]; then
  cache_root=${HOME:?}/Library/Caches
else
  cache_root=${HOME:?}/.cache
fi
case "$cache_root" in /*) ;; *) printf '%s\n' 'PromptSift: cache path must be absolute.' >&2; exit 1 ;; esac
cache_dir=$cache_root/prompt-sift/jq-$version/$asset
jq_binary=$cache_dir/jq
if [ -f "$jq_binary" ] && [ -x "$jq_binary" ] && verify "$jq_binary"; then
  printf '%s\n' "$jq_binary"
  exit 0
fi
command -v curl >/dev/null 2>&1 || exit 1
# Require an integrity checker BEFORE performing network I/O.
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || exit 1
mkdir -p "$cache_dir"
[ ! -L "$cache_dir" ] && [ ! -L "$jq_binary" ] || exit 1
staging=$(mktemp -d "$cache_dir/.download.XXXXXX")
trap 'rm -rf "$staging"' EXIT
trap 'exit 1' HUP INT TERM
printf 'PromptSift: installing verified jq %s in the user cache.\n' "$version" >&2
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 3 --max-time 12 --max-filesize 10000000 \
  --output "$staging/jq" "https://github.com/jqlang/jq/releases/download/jq-$version/$asset" || exit 1
if ! verify "$staging/jq"; then
  printf '%s\n' 'PromptSift: jq checksum mismatch; downloaded binary will not be executed.' >&2
  exit 1
fi
chmod 700 "$staging/jq"
# Only execute after verification; then atomically publish for concurrent hooks.
"$staging/jq" --version >/dev/null 2>&1 || exit 1
mv -f "$staging/jq" "$jq_binary"
printf '%s\n' "$jq_binary"
