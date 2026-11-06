#!/usr/bin/env bash
# Adds the narration in a walkthrough-voice.tar.gz (walkthrough.yml packs one per run) to a
# voice cache: unpack-voice.sh <archive> <cache>. The recorder writes into the cache later,
# so nothing may come out of the archive except plain files at plain paths inside it: an
# archive with anything else (a symlink or hard link, a device, an absolute path, a '..'
# part) is refused whole before anything is written. Files already in the cache are kept.
set -euo pipefail
archive="${1:?usage: unpack-voice.sh <archive> <cache>}"
cache="${2:?usage: unpack-voice.sh <archive> <cache>}"
fail() { echo "::error::$*" >&2; exit 1; }

[ -f "$archive" ] && [ ! -L "$archive" ] || fail "$archive is not a file"

# The first character of each `tar -tv` line is the entry's type: '-' file, 'd' folder,
# 'l' symlink, 'h' hard link, and others for devices and pipes. -P lists names as they are
# stored, before tar would strip a leading '/'; names are escaped one per line.
types=$(tar -tvzPf "$archive" | cut -c1 | sort -u | tr -d '\n')
case "$types" in *[!-d]*) fail "$archive holds something other than plain files and folders ($types)" ;; esac
while IFS= read -r name; do
  case "/$name/" in
    //*) fail "$archive holds an absolute path: $name" ;;
    */../*) fail "$archive holds a path with '..': $name" ;;
  esac
done < <(tar -tzPf "$archive")

# The cache is a path inside the working directory (walkthrough.yml passes
# walkthrough/.cache/voice). None of its parts may be a link, or the copy below would land
# wherever that link points, so they are checked before anything is created.
case "/$cache/" in
  //*|*/../*) fail "The cache must be a relative path without '..': $cache" ;;
esac
IFS=/ read -r -a parts <<<"$cache"
part=.
for p in "${parts[@]}"; do
  if [ -z "$p" ] || [ "$p" = . ]; then continue; fi
  part="$part/$p"
  [ ! -L "$part" ] || fail "$part is a link"
  [ ! -e "$part" ] || [ -d "$part" ] || fail "$part is not a folder"
done
mkdir -p "$cache"

# Fails if anything under $1 isn't a plain file or folder. A scan that can't read everything fails,
# rather than passing over what it couldn't see.
odd() {
  local found
  found=$(find "$1" ! -type f ! -type d -print -quit) || fail "Couldn't check everything in $1"
  [ -z "$found" ] || fail "$1 holds something other than plain files and folders: $found"
}
# The cache holds only what this script and the recorder put there, never links.
odd "$cache"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/stage"
mkdir "$stage"
tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions
# Checked again on what was actually unpacked, then only plain files are copied across.
odd "$stage"
find "$stage" -type f -print0 > "$work/files" || fail "Couldn't list everything $archive unpacked to"
added=0 kept=0
while IFS= read -r -d '' f; do
  rel="${f#"$stage"/}"
  target="$cache/$rel"
  if [ -e "$target" ] || [ -L "$target" ]; then kept=$((kept + 1)); continue; fi
  mkdir -p "$(dirname "$target")"
  cp -- "$f" "$target"
  added=$((added + 1))
done < "$work/files"
echo "Added $added narration file(s) to $cache ($kept already there)"
