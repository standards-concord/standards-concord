#!/usr/bin/env bash
# Vercel's "Ignored Build Step" (vercel.json ignoreCommand): exit 0 skips the build, 1 builds.
#
# Vercel serves only the static web app and the routing middleware; the API runs on the
# backend server, which deploys from the CI image. So a push to main that changes none of
# the files below (server-only, docs, tests, workflows) needs no new Vercel deployment.
# Anything unexpected (no previous deployment, a commit outside the shallow clone) builds.
set -u
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$prev" ]; then
  echo "No previous deployment to compare with: building."
  exit 1
fi
if git diff --quiet "$prev" HEAD -- \
  apps/web packages middleware.ts vercel.json package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json \
  scripts/vercel-ignore-build.sh; then
  echo "Nothing the web app or middleware uses changed since $prev: skipping the build."
  exit 0
fi
echo "The web app or middleware changed since $prev: building."
exit 1
