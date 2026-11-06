#!/usr/bin/env bash
# Run CI's jobs (.github/workflows/ci.yml) on this machine instead of GitHub Actions, and
# optionally record each result as a commit status on the commit that was tested.
#
#   scripts/ci-local.sh                     # test, e2e-dev, e2e-preview, e2e-solid, walkthrough
#   scripts/ci-local.sh test e2e-dev        # just these jobs
#   scripts/ci-local.sh --report            # also post a "local/<job>" commit status per job
#
# Why: while the organisation has no Actions minutes, threads and people run the checks
# themselves. --report posts the result where a reviewer (and a later required check) can
# see it: success only when the job passed on a clean checkout of exactly that commit.
#
# Needs Node 22 + pnpm, Python 3 (uv optional), Postgres 16 binaries (initdb/pg_ctl) for the
# test job, Chromium for Playwright, ffmpeg for the walkthrough, Go for the MCP publisher
# check (skipped with a warning if missing), and gh (signed in) for --report.
set -uo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

report=false
jobs=()
for arg in "$@"; do
  case "$arg" in
    --report) report=true ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) jobs+=("$arg") ;;
  esac
done
[ ${#jobs[@]} -eq 0 ] && jobs=(test e2e-dev e2e-preview e2e-solid walkthrough)

sha=$(git rev-parse HEAD)
if $report; then
  if ! git diff --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard -- apps packages e2e walkthrough scripts)" ]; then
    echo "--report needs a clean working tree, so the status describes exactly $sha." >&2
    exit 2
  fi
  # owner/name from origin (REST only: gh repo view needs GraphQL, which Claude sandboxes lack).
  repo=$(git remote get-url origin | sed -E 's#^(git@[^:]+:|[a-z]+://([^@/]*@)?[^/]+/)##; s#\.git$##')
  gh api "repos/$repo" --jq .full_name >/dev/null || { echo "gh can't reach $repo: sign in with gh auth login" >&2; exit 2; }
fi

logdir="$root/ci-local-logs/${sha:0:12}"
mkdir -p "$logdir"
rm -f "$logdir"/*.note
runner="${CI_LOCAL_RUNNER:-$(whoami)@$(hostname)}"

status() { # job state description
  $report || return 0
  gh api -X POST "repos/$repo/statuses/$sha" \
    -f state="$2" -f context="local/$1" -f description="$3 ($runner)" >/dev/null \
    || echo "warning: could not post the local/$1 status" >&2
}

# A throwaway Postgres for the document store's tests, as CI's postgres:16 service.
pg_started=false
start_postgres() {
  [ -n "${TEST_DATABASE_URL:-}" ] && return 0
  local bin
  bin=$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl 2>/dev/null | sort -V | tail -1)")
  [ -x "$bin/pg_ctl" ] || { echo "No Postgres found: install postgresql-16 or set TEST_DATABASE_URL" >&2; return 1; }
  pgdir=$(mktemp -d)
  local run=("$bin/initdb" -D "$pgdir/data" -U postgres --auth=trust -E UTF8)
  local ctl=("$bin/pg_ctl" -D "$pgdir/data" -l "$pgdir/log" -o "-p 55432 -k $pgdir -c listen_addresses=localhost" -w)
  if [ "$(id -u)" = 0 ]; then # initdb refuses root
    chown -R nobody "$pgdir" 2>/dev/null || chown -R nobody:nogroup "$pgdir"
    su nobody -s /bin/sh -c "$(printf '%q ' "${run[@]}") >/dev/null && $(printf '%q ' "${ctl[@]}") start >/dev/null" || return 1
  else
    "${run[@]}" >/dev/null && "${ctl[@]}" start >/dev/null || return 1
  fi
  pg_started=true
  export TEST_DATABASE_URL="postgres://postgres@localhost:55432/postgres"
}
stop_postgres() {
  $pg_started || return 0
  local bin; bin=$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | sort -V | tail -1)")
  if [ "$(id -u)" = 0 ]; then su nobody -s /bin/sh -c "$bin/pg_ctl -D $pgdir/data stop -m fast >/dev/null"; else "$bin/pg_ctl" -D "$pgdir/data" stop -m fast >/dev/null; fi
  rm -rf "$pgdir"
}

job_test() {
  # Each job runs in a subshell, so Postgres is started and stopped inside it.
  trap stop_postgres EXIT
  start_postgres || return 1
  ./toolkit/setup.sh >/dev/null || return 1
  pnpm -r typecheck || return 1
  pnpm -r test || return 1
  ONTOLOGY_STORE=db pnpm --filter @concord/server test || return 1
  pnpm --filter @concord/web build || return 1
  node scripts/public-url.mjs --check || return 1
  # Two plugin schemas live on agent-plugins.org, which a Claude sandbox's network policy may
  # block. Then check the rest (the script skips what it can't fetch outside CI) and say so.
  if NODE_USE_ENV_PROXY=1 node -e "fetch('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',{signal:AbortSignal.timeout(15000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    node scripts/validate-listings.mjs || return 1
  else
    echo "warning: agent-plugins.org is unreachable here, so its two plugin schemas weren't checked" >&2
    CI= node scripts/validate-listings.mjs || return 1
    echo "agent-plugins.org schemas not checked" >"$logdir/test.note"
  fi
  node scripts/move-repo.mjs --check || return 1
  local pub="$HOME/.local/bin/mcp-publisher"
  if [ ! -x "$pub" ] && command -v go >/dev/null; then
    GOBIN="$HOME/.local/bin" go install github.com/modelcontextprotocol/registry/cmd/publisher@v1.8.6 \
      && mv "$HOME/.local/bin/publisher" "$pub"
  fi
  if [ -x "$pub" ]; then "$pub" validate || return 1; else echo "warning: no Go, MCP Registry entry not validated" >&2; fi
}
job_e2e-dev() { E2E_MODE=dev pnpm test:e2e; }
job_e2e-preview() { pnpm --filter @concord/web build && E2E_MODE=preview pnpm test:e2e; }
job_e2e-solid() { pnpm test:e2e:solid; }
job_walkthrough() {
  WALKTHROUGH_BROWSER_TESTS=1 pnpm --filter @concord/walkthrough test || return 1
  pnpm walkthrough --check --strict
}

export CI=1
pnpm install --frozen-lockfile >/dev/null || { echo "pnpm install failed" >&2; exit 1; }

failed=()
for job in "${jobs[@]}"; do
  if ! declare -F "job_$job" >/dev/null; then echo "Unknown job: $job" >&2; exit 2; fi
  status "$job" pending "running locally"
  start=$(date +%s)
  echo "== $job (log: $logdir/$job.log)"
  if ( "job_$job" ) >"$logdir/$job.log" 2>&1; then
    took=$(( ($(date +%s) - start) / 60 ))
    echo "   passed in ${took} min"
    note=""; [ -f "$logdir/$job.note" ] && note="; $(cat "$logdir/$job.note")"
    status "$job" success "passed in ${took} min$note"
  else
    took=$(( ($(date +%s) - start) / 60 ))
    echo "   FAILED after ${took} min; last lines:"
    tail -25 "$logdir/$job.log" | sed 's/^/   | /'
    status "$job" failure "failed after ${took} min"
    failed+=("$job")
  fi
done

[ ${#failed[@]} -eq 0 ] && { echo "All passed at $sha"; exit 0; }
echo "Failed at $sha: ${failed[*]}"
exit 1
