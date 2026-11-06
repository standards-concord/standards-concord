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

mkdir -p "$cache"
# The cache holds only what this script and the recorder put there, never links.
if [ -n "$(find "$cache" ! -type f ! -type d -print -quit)" ]; then fail "$cache holds something other than plain files and folders"; fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions
# Checked again on what was actually unpacked, then only plain files are copied across.
if [ -n "$(find "$stage" ! -type f ! -type d -print -quit)" ]; then fail "$archive unpacked to something other than plain files and folders"; fi
added=0 kept=0
while IFS= read -r -d '' f; do
  rel="${f#"$stage"/}"
  target="$cache/$rel"
  if [ -e "$target" ] || [ -L "$target" ]; then kept=$((kept + 1)); continue; fi
  mkdir -p "$(dirname "$target")"
  cp -- "$f" "$target"
  added=$((added + 1))
done < <(find "$stage" -type f -print0)
echo "Added $added narration file(s) to $cache ($kept already there)"
