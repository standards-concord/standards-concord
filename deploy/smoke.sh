#!/bin/bash
# End-to-end check of a live Concord deployment, through the same URL testers use.
#   ./deploy/smoke.sh https://standards-concord.vercel.app
# Signs in as a demo tester, then reads, validates (HermiT), queries, interviews,
# raises a change request and checks the meeting stream and MCP endpoint.
set -uo pipefail
base=${1:?Usage: smoke.sh <public url>}
base=${base%/}
jar=$(mktemp); trap 'rm -f "$jar"' EXIT
fails=0
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(String($1))})"; }
check() { # name, expected status, curl args...
  local name=$1 want=$2; shift 2
  local out code
  out=$(curl -sS -m 120 -b "$jar" -c "$jar" -w '\n%{http_code}' "$@" 2>&1); code=${out##*$'\n'}; body=${out%$'\n'*}
  if [ "$code" = "$want" ]; then echo "ok   $name ($code)"; else echo "FAIL $name: got $code, want $want: ${body:0:300}"; fails=$((fails+1)); fi
}
post() { check "$1" "$2" -X POST -H 'Content-Type: application/json' -d "$4" "$base$3"; }

check 'health' 200 "$base/healthz"
check 'alpha page' 200 "$base/alpha"
post 'demo sign-in' 200 /api/auth/demo '{"name":"Smoke test","role":"editor"}'
check 'session' 200 "$base/api/session"
check 'ontology list' 200 "$base/api/ontologies"
id=$(printf %s "$body" | json 'v[0].id')
echo "     ontology: $id"
check 'ontology view' 200 "$base/api/ontologies/$id/view"
check 'Turtle source' 200 "$base/api/ontologies/$id/source"
check 'validation (HermiT)' 200 "$base/api/ontologies/$id/validation"
printf '     reasoner: %s\n' "$(printf %s "$body" | json 'JSON.stringify(v.reasoner ?? Object.keys(v))' 2>/dev/null)"
post 'SPARQL' 200 "/api/ontologies/$id/sparql" '{"query":"SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }"}'
post 'start interview' 201 "/api/ontologies/$id/interviews" '{}'
iv=$(printf %s "$body" | json 'v.id')
post 'interview turn' 200 "/api/interviews/$iv/messages" '{"content":"We need to record which dataset a licence applies to."}'
post 'change request' 201 "/api/ontologies/$id/change-requests" '{"title":"Smoke test: add a label","description":"Raised by deploy/smoke.sh; safe to reject.","kind":"editorial"}'
check 'meetings list' 200 "$base/api/ontologies/$id/meetings"
check 'MCP needs a token' 401 -X POST -H 'Content-Type: application/json' -d '{}' "$base/mcp"
check 'public ontology page' 200 "$base/def/volunteering"
check 'version IRI as Turtle' 200 -H 'Accept: text/turtle' "$base/def/volunteering/1.0.0"
post 'sign out' 200 /api/auth/logout '{}'

[ "$fails" = 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
