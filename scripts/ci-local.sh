#!/usr/bin/env bash
# Run CI's jobs (.github/workflows/ci.yml) on this machine instead of GitHub Actions, and
# optionally record each result for the commit that was tested.
#
#   scripts/ci-local.sh                     # test, e2e-dev, e2e-preview, e2e-solid, walkthrough
#   scripts/ci-local.sh test e2e-dev        # just these jobs
#   scripts/ci-local.sh --report            # also record the result (see below)
#   scripts/ci-local.sh --parallel 6 --shards 4
#   scripts/ci-local.sh --update-timings    # refresh e2e/timings.json from this run
#
# Why: while the organisation has no Actions minutes, threads and people run the checks
# themselves. --report records the result where a reviewer can see it, only for a clean
# checkout of exactly that commit: a commit status per job where gh may post one, and always
# ci-local-logs/<commit>/summary.md, which a Claude thread (whose GitHub proxy doesn't allow
# posting statuses) posts on the pull request as a comment instead.
#
# Speed: the jobs run side by side (--parallel, default one and a half per CPU: browser tests
# mostly wait; more than that starves the unit tests' timing checks), and the browser suite is split into --shards pieces (default 6) of similar length by
# e2e/timings.json (scripts/e2e-shards.mjs), each with its own API server, web server, data
# directory and ports, so no two pieces share state. The web app is built once up front. As
# in CI, the dev server gets a smoke test and the production build the whole suite.
#
# Needs Node 22 + pnpm, Python 3 (uv optional), Postgres 16 binaries (initdb/pg_ctl) for the
# test job, Chromium for Playwright, ffmpeg for the walkthrough, Go for the MCP publisher
# check (skipped with a warning if missing), and gh (signed in) for --report.
set -uo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

report=false
update_timings=false
cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)
parallel=$(( cpus + cpus / 2 ))
shards=6
jobs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --report) report=true ;;
    --update-timings) update_timings=true ;;
    --parallel) parallel=$2; shift ;;
    --shards) shards=$2; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) jobs+=("$1") ;;
  esac
  shift
done
[ ${#jobs[@]} -eq 0 ] && jobs=(test e2e-dev e2e-preview e2e-solid walkthrough)
for job in "${jobs[@]}"; do
  case "$job" in test|e2e-dev|e2e-preview|e2e-solid|walkthrough) ;; *) echo "Unknown job: $job" >&2; exit 2 ;; esac
done

sha=$(git rev-parse HEAD)
if $report; then
  if ! git diff --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard -- apps packages e2e walkthrough scripts)" ]; then
    echo "--report needs a clean working tree, so the result describes exactly $sha." >&2
    exit 2
  fi
  # owner/name from origin (REST only: gh repo view needs GraphQL, which Claude sandboxes lack).
  repo=$(git remote get-url origin | sed -E 's#^(git@[^:]+:|[a-z]+://([^@/]*@)?[^/]+/)##; s#\.git$##')
  gh api "repos/$repo" --jq .full_name >/dev/null || { echo "gh can't reach $repo: sign in with gh auth login" >&2; exit 2; }
fi

logdir="$root/ci-local-logs/${sha:0:12}"
rm -rf "$logdir"
mkdir -p "$logdir"
runner="${CI_LOCAL_RUNNER:-$(whoami)@$(hostname)}"

statuses_posted=true
status() { # job state description
  $report && $statuses_posted || return 0
  gh api -X POST "repos/$repo/statuses/$sha" \
    -f state="$2" -f context="local/$1" -f description="$3 ($runner)" >/dev/null 2>&1 \
    || { statuses_posted=false; echo "note: gh may not post commit statuses here; the result goes in $logdir/summary.md" >&2; }
}

# A throwaway Postgres for the document store's tests, as CI's postgres:16 service. Each test
# piece gets its own database, so the two store passes can run at once.
pg_started=false
pg() { # run a Postgres binary, as nobody when we are root (initdb refuses root)
  local bin; bin=$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl 2>/dev/null | sort -V | tail -1)")
  [ -x "$bin/$1" ] || { echo "No Postgres found: install postgresql-16 or set TEST_DATABASE_URL" >&2; return 1; }
  local cmd; cmd="$bin/$1"; shift
  if [ "$(id -u)" = 0 ]; then su nobody -s /bin/sh -c "$(printf '%q ' "$cmd" "$@")"; else "$cmd" "$@"; fi
}
start_postgres() {
  [ -n "${TEST_DATABASE_URL:-}" ] && return 0
  pgdir=$(mktemp -d)
  [ "$(id -u)" = 0 ] && { chown -R nobody "$pgdir" 2>/dev/null || chown -R nobody:nogroup "$pgdir"; }
  pg initdb -D "$pgdir/data" -U postgres --auth=trust -E UTF8 >/dev/null || return 1
  pg pg_ctl -D "$pgdir/data" -l "$pgdir/log" -o "-p 55432 -k $pgdir -c listen_addresses=localhost -c max_connections=200" -w start >/dev/null || return 1
  pg_started=true
  for db in unit store; do psql -q -h localhost -p 55432 -U postgres -c "create database ci_$db" postgres || return 1; done
  pg_base="postgres://postgres@localhost:55432"
}
stop_postgres() {
  $pg_started || return 0
  pg pg_ctl -D "$pgdir/data" stop -m fast >/dev/null
  rm -rf "$pgdir"
}
cleanup() { kill $(jobs -p) 2>/dev/null; stop_postgres; }
trap cleanup EXIT

# --- The pieces. Each runs in its own process with its own log; a job passes when all its
# pieces pass. ---

piece_test-unit() {
  export TEST_DATABASE_URL="${TEST_DATABASE_URL:-$pg_base/ci_unit}"
  ./toolkit/setup.sh >/dev/null || return 1
  pnpm -r typecheck || return 1
  # One package at a time: each test runner already uses every CPU, and four at once (next to
  # the database run of the server tests) left the timing checks too little CPU to pass.
  pnpm -r --workspace-concurrency=1 test || return 1
  node scripts/public-url.mjs --check || return 1
  # The schemas are fetched online. NODE_USE_ENV_PROXY lets Node's fetch use HTTPS_PROXY where a
  # sandbox only reaches the internet through one (a no-op elsewhere). As in CI, a schema that
  # can't be fetched fails the check rather than being skipped.
  NODE_USE_ENV_PROXY=1 node scripts/validate-listings.mjs || return 1
  node scripts/move-repo.mjs --check || return 1
  # The MCP Registry publisher, pinned as in CI: a release binary, or built with Go.
  local pub="$HOME/.local/bin/mcp-publisher" arch
  arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
  if [ ! -x "$pub" ]; then
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/download/v1.8.6/mcp-publisher_$(uname -s | tr A-Z a-z)_$arch.tar.gz" \
      | tar -xz -C "$HOME/.local/bin" mcp-publisher 2>/dev/null \
      || { command -v go >/dev/null && GOBIN="$HOME/.local/bin" go install github.com/modelcontextprotocol/registry/cmd/publisher@v1.8.6 \
        && mv "$HOME/.local/bin/publisher" "$pub"; }
  fi
  if [ -x "$pub" ]; then
    # It calls the registry's validate API; one retry for a dropped connection, not a failure.
    "$pub" validate || { echo "retrying the MCP Registry validation once" >&2; "$pub" validate; } || return 1
  else
    echo "warning: couldn't get mcp-publisher, so server.json was NOT validated" >&2
    echo "MCP Registry entry (server.json) NOT validated: no mcp-publisher" >"$logdir/test.note"
  fi
}
# Ontologies' history in the database instead of git repositories on disk (as on Vercel).
piece_test-store() { TEST_DATABASE_URL="${TEST_DATABASE_URL:-$pg_base/ci_store}" ONTOLOGY_STORE=db pnpm --filter @concord/server test; }
# Each piece gets its own servers, data directory, ports and output folder.
e2e_env() { # n
  local base=$((9000 + $1 * 10))
  export E2E_API_PORT=$base E2E_WEB_PORT=$((base + 1)) E2E_GITHUB_STUB_PORT=$((base + 2)) E2E_DATA_DIR="$(mktemp -d)"
}
# The whole suite against the production build (what Vercel serves), in shards.
piece_e2e-preview() {
  e2e_env "$1"
  local files; files=$(node scripts/e2e-shards.mjs "$shards" | sed -n "${1}p")
  [ -n "$files" ] || { echo "shard $1 has no files"; return 0; }
  # shellcheck disable=SC2086 # one argument per spec file
  E2E_MODE=preview PLAYWRIGHT_JSON_OUTPUT_NAME="$logdir/preview-$1.json" \
    pnpm exec playwright test -c e2e --project=local --reporter=list,json --output "test-results/preview-$1" $files
}
# A smoke test against the Vite dev server (what `pnpm dev` runs), as CI does.
piece_e2e-dev() { e2e_env 0; E2E_MODE=dev pnpm test:e2e:smoke --output test-results/dev; }
piece_e2e-solid() { pnpm test:e2e:solid; }
piece_walkthrough() {
  WALKTHROUGH_BROWSER_TESTS=1 pnpm --filter @concord/walkthrough test || return 1
  renice -n 10 -p $BASHPID >/dev/null 2>&1 # its unit tests have time limits; the check below just waits
  pnpm walkthrough --check --strict
}

# The unit tests first (they use the most CPU, and nothing else gets ahead of them), then the
# longest pieces, so the slowest start straight away.
pieces=()
want() { printf '%s\n' "${jobs[@]}" | grep -qx "$1"; }
want test && pieces+=(test:unit test:store)
want walkthrough && pieces+=(walkthrough:all)
for i in $(seq 1 "$shards"); do want e2e-preview && pieces+=("e2e-preview:$i"); done
want e2e-dev && pieces+=(e2e-dev:smoke)
want e2e-solid && pieces+=(e2e-solid:all)

run_piece() { # job:part
  local job=${1%%:*} part=${1#*:}
  # The unit tests include timing checks ("answers within 5 s", "doesn't block the main
  # thread"), so they keep normal priority; the browser pieces, which mostly wait anyway,
  # run at low priority and soak up whatever CPU is left.
  [ "$job" = test ] || [ "$job" = walkthrough ] || renice -n 10 -p $BASHPID >/dev/null 2>&1
  case "$job" in
    test) "piece_test-$part" ;;
    e2e-preview) piece_e2e-preview "$part" ;;
    *) "piece_$job" ;;
  esac
}

export CI=1
started=$(date +%s)
# CPU time used so far by the whole machine (user, nice and system), in microseconds; 0 where
# /proc/stat doesn't exist (macOS), which skips the CPU line at the end.
cpu_usec() { awk '/^cpu / { printf "%.0f", ($2 + $3 + $4) * 1000000 / 100; exit }' /proc/stat 2>/dev/null || echo 0; }
cpu_started=$(cpu_usec)
echo "Installing and building the web app once…"
pnpm install --frozen-lockfile >"$logdir/setup.log" 2>&1 \
  && pnpm --filter @concord/web build >>"$logdir/setup.log" 2>&1 \
  || { echo "Setup failed; see $logdir/setup.log" >&2; tail -20 "$logdir/setup.log" >&2; exit 1; }
if want test && [ -z "${TEST_DATABASE_URL:-}" ]; then start_postgres || { echo "Couldn't start Postgres" >&2; exit 1; }; fi

for job in "${jobs[@]}"; do status "$job" pending "running locally"; done
echo "Running ${#pieces[@]} pieces, $parallel at a time (logs: $logdir)"

declare -A pid_piece piece_start piece_rc
running=0
finish_one() {
  local done_pid
  wait -n -p done_pid; local rc=$?
  local p=${pid_piece[$done_pid]}
  piece_rc[$p]=$rc
  local took=$(( $(date +%s) - ${piece_start[$p]} ))
  # CPU seconds the piece used (its processes' user + system time), to see where the time goes.
  local cpu; cpu=$(awk 'NR==2 { gsub(/s/, ""); split($1, u, "m"); split($2, s, "m"); printf "%d", u[1]*60 + u[2] + s[1]*60 + s[2] }' "$logdir/${p/:/-}.cpu" 2>/dev/null)
  if [ "$rc" = 0 ]; then printf '   ok    %-16s %3dm%02ds  cpu %ss\n' "$p" $((took / 60)) $((took % 60)) "${cpu:-?}"
  else printf '   FAIL  %-16s %3dm%02ds  cpu %ss  (log: %s)\n' "$p" $((took / 60)) $((took % 60)) "${cpu:-?}" "$logdir/${p/:/-}.log"; fi
  running=$((running - 1))
}
for p in "${pieces[@]}"; do
  while [ "$running" -ge "$parallel" ]; do finish_one; done
  ( run_piece "$p"; rc=$?; times >"$logdir/${p/:/-}.cpu"; exit $rc ) >"$logdir/${p/:/-}.log" 2>&1 &
  pid_piece[$!]=$p
  piece_start[$p]=$(date +%s)
  running=$((running + 1))
done
while [ "$running" -gt 0 ]; do finish_one; done
total=$(( $(date +%s) - started ))
cpu_total=$(( ($(cpu_usec) - cpu_started) / 1000000 ))
[ "$cpu_total" -gt 0 ] && echo "CPU used: ${cpu_total}s over ${total}s on $cpus CPUs ($(( cpu_total * 100 / (total * cpus) ))% busy)"
if $update_timings && ls "$logdir"/preview-*.json >/dev/null 2>&1; then node scripts/e2e-shards.mjs --update "$logdir"/preview-*.json; fi

printf '### Local CI run\n\nCommit `%s`, run by `%s` with `scripts/ci-local.sh`, %s, in %dm%02ds.\n\n| Job | Result |\n| --- | --- |\n' \
  "$sha" "$runner" "$(date -u +'%Y-%m-%d %H:%M UTC')" $((total / 60)) $((total % 60)) >"$logdir/summary.md"
failed=()
for job in "${jobs[@]}"; do
  ok=true
  for p in "${pieces[@]}"; do [ "${p%%:*}" = "$job" ] && [ "${piece_rc[$p]}" != 0 ] && ok=false; done
  if $ok; then
    note=""; [ "$job" = test ] && [ -f "$logdir/test.note" ] && note="; $(cat "$logdir/test.note")"
    [ "$job" = e2e-dev ] && note="$note (smoke test, as in CI)"
    status "$job" success "passed$note"
    echo "| local/$job | ✅ passed$note |" >>"$logdir/summary.md"
  else
    status "$job" failure "failed"
    echo "| local/$job | ❌ failed |" >>"$logdir/summary.md"
    failed+=("$job")
    for p in "${pieces[@]}"; do
      [ "${p%%:*}" = "$job" ] && [ "${piece_rc[$p]}" != 0 ] && { echo "--- last lines of $p"; tail -30 "$logdir/${p/:/-}.log"; }
    done
  fi
done

echo "Took $((total / 60))m$((total % 60))s."
$report && ! $statuses_posted && echo "Statuses weren't posted. Post $logdir/summary.md on the pull request as a comment."
[ ${#failed[@]} -eq 0 ] && { echo "All passed at $sha"; exit 0; }
echo "Failed at $sha: ${failed[*]}"
exit 1
