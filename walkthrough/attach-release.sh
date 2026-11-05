#!/usr/bin/env bash
# Attaches a recording (out/) to release $TAG of $REPO (walkthrough.yml's attach job).
# The videos were recorded from commit $SHA, so a tag that already exists must point at
# it: --target only applies when gh creates the tag. Any failed lookup stops here rather
# than skipping the check.
set -euo pipefail
: "${REPO:?}" "${TAG:?}" "${SHA:?}"

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

files=()
for v in concord-walkthrough concord-feedback; do
  for ext in mp4 vtt transcript.md chapters.txt; do
    [ -f "out/$v.$ext" ] || { echo "::error::out/$v.$ext is missing"; exit 1; }
    files+=("out/$v.$ext")
  done
done
gh release upload "$TAG" --repo "$REPO" --clobber "${files[@]}" out/walkthrough-voice.tar.gz
