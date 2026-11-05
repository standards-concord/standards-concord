#!/usr/bin/env bash
# Attaches a recording (out/) to release $TAG of $REPO (walkthrough.yml's attach job).
# The videos were recorded from commit $SHA, so a tag that already exists must point at
# it: --target only applies when gh creates the tag. Any failed lookup stops here rather
# than skipping the check.
set -euo pipefail
: "${REPO:?}" "${TAG:?}" "${SHA:?}"

# Everything /welcome plays must be here before anything is written: both videos, and the
# feature clips' playlist with every clip it lists.
files=()
need() {
  [ -f "out/$1" ] || { echo "::error::out/$1 is missing"; exit 1; }
  files+=("out/$1")
}
for v in concord-walkthrough concord-feedback; do
  for ext in mp4 vtt transcript.md chapters.txt; do need "$v.$ext"; done
done
need concord-clips.json
if ! clips=$(jq -r '.clips[].file' out/concord-clips.json) || [ -z "$clips" ]; then
  echo "::error::out/concord-clips.json lists no clips"; exit 1
fi
while IFS= read -r c; do
  [[ "$c" =~ ^concord-clip-[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error::'$c' isn't a clip's name"; exit 1; }
  for ext in mp4 vtt transcript.md chapters.txt; do need "$c.$ext"; done
done <<< "$clips"

# matching-refs is a prefix match, so look for the exact ref.
if ! refs=$(gh api "repos/$REPO/git/matching-refs/tags/$TAG" --jq ".[] | select(.ref == \"refs/tags/$TAG\") | .ref"); then
  echo "::error::Couldn't look up tag $TAG, so its commit can't be checked"; exit 1
fi
tagged=""
if [ -n "$refs" ]; then
  if ! tagged=$(gh api "repos/$REPO/commits/refs/tags/$TAG" --jq .sha) || [ -z "$tagged" ]; then
    echo "::error::Couldn't read which commit $TAG points at"; exit 1
  fi
  [ "$tagged" = "$SHA" ] || { echo "::error::$TAG is $tagged, but the videos were recorded from $SHA"; exit 1; }
fi

# A tag named by hand that has no release yet gets one, from the commit recorded.
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "::error::'$TAG' isn't a version tag like v0.18.0"; exit 1; }
  if [ -n "$tagged" ]; then
    gh release create "$TAG" --repo "$REPO" --verify-tag --title "Concord ${TAG#v}" --generate-notes
  else
    gh release create "$TAG" --repo "$REPO" --target "$SHA" --title "Concord ${TAG#v}" --generate-notes
  fi
fi

gh release upload "$TAG" --repo "$REPO" --clobber "${files[@]}" out/walkthrough-voice.tar.gz
