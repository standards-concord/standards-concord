#!/usr/bin/env bash
# Adds the narration kept in an earlier walkthrough run's artifact to the voice cache:
# seed-voice.sh <run id> <cache>, with REPO (owner/name) and GH_TOKEN set. Narration is
# kept with each release a run attaches to; a run that attaches nothing (such as a features
# run) keeps it only in its artifact, and this saves paying for it again.
#
# The cache is trusted (its audio is reused and packed into later releases), so only an
# artifact this workflow made in this repository is accepted: the run must be
# walkthrough.yml, started by hand or by a release (both need write access here, unlike a
# pull request from a fork), from a branch of this repository.
set -euo pipefail
run="${1:-}"
cache="${2:?usage: seed-voice.sh <run id> <cache>}"
: "${REPO:?REPO (owner/name) is required}"
fail() { echo "::error::$*" >&2; exit 1; }

case "$run" in
  ''|*[!0-9]*) fail "seed_voice_run must be a run id (digits only)" ;;
esac

info=$(gh api "repos/$REPO/actions/runs/$run") || fail "Couldn't look up run $run"
workflow=$(jq -r '.path // ""' <<<"$info")
event=$(jq -r '.event // ""' <<<"$info")
head=$(jq -r '.head_repository.full_name // ""' <<<"$info")
[ "$workflow" = .github/workflows/walkthrough.yml ] || fail "Run $run is from '$workflow', not .github/workflows/walkthrough.yml"
case "$event" in
  workflow_dispatch|release) ;;
  *) fail "Run $run was started by '$event'; only runs started by hand or by a release are trusted" ;;
esac
[ "$head" = "$REPO" ] || fail "Run $run recorded '$head', not $REPO"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh run download "$run" --repo "$REPO" --name concord-walkthrough --dir "$work/artifact"
archive="$work/artifact/walkthrough-voice.tar.gz"
[ -f "$archive" ] || fail "Run $run's artifact has no walkthrough-voice.tar.gz"
bash "$(dirname "${BASH_SOURCE[0]}")/unpack-voice.sh" "$archive" "$cache"
echo "Seeded narration from run $run"
