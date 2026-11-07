#!/bin/bash
# Publishes actions/app-check to its public home, standards-concord/app-check, which the workflows
# Concord hands out use as `standards-concord/app-check@v1`. Run it after changing the action:
#
#   scripts/publish-action.sh [v1]
#
# It clones the public repository into a temporary folder, replaces its files with this folder's,
# commits if anything changed, moves the major-version tag (v1 unless given) to that commit and
# pushes both. Use a new major version for a change that breaks existing workflows.
set -euo pipefail
tag=${1:-v1}
[[ "$tag" =~ ^v[0-9]+$ ]] || { echo "The tag is a major version, like v1" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/actions/app-check"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git clone -q https://github.com/standards-concord/app-check.git "$dir/app-check"
cd "$dir/app-check"
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp "$src/action.yml" "$src/run.mjs" "$src/README.md" .
# The maintainer note is for this repository, not for people using the action.
awk 'BEGIN{skip=0} /^> \*\*Maintainers:\*\*/{skip=1; next} skip==1 && /^$/{skip=0; next} skip==0{print}' README.md > README.tmp && mv README.tmp README.md
git add -A
if git diff --cached --quiet; then
  echo "No changes since the last publish."
else
  git commit -q -m "Publish from standards-concord/standards-concord@$(git -C "$root" rev-parse --short HEAD)"
fi
git tag -f "$tag"
git push -q origin HEAD:main
git push -q -f origin "refs/tags/$tag"
echo "Published $(git rev-parse --short HEAD) as $tag"
