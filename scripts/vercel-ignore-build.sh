#!/usr/bin/env bash
# Vercel's "Ignored Build Step" (vercel.json ignoreCommand): exit 0 skips the build, 1 builds.
#
# Vercel serves the web app and, since step 5, the API as a function (scripts/vercel-build.mjs;
# with BACKEND_URL set, the routing middleware forwards the API to that server instead). So a
# push to main that changes none of the files below (docs, tests, workflows) needs no new
# Vercel deployment.
# Anything unexpected (no previous deployment, a commit outside the shallow clone) builds.
set -u
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$prev" ]; then
  echo "No previous deployment to compare with: building."
  exit 1
fi
if git diff --quiet "$prev" HEAD -- \
  apps/web apps/server/src apps/server/package.json apps/server/tsconfig.json apps/server/vercel-entry.mjs \
  packages middleware.ts vercel.json package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json \
  scripts/vercel-ignore-build.sh scripts/vercel-build.mjs scripts/vercel-output.mjs; then
  echo "Nothing the web app, the API or the middleware uses changed since $prev: skipping the build."
  exit 0
fi
echo "The web app, the API or the middleware changed since $prev: building."
exit 1
