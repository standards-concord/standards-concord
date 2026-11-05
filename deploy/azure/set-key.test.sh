#!/bin/bash
# Checks that set-key.sh never exposes the secret. It used to pass the base64 of the value inside
# `az --scripts "..."` (visible to `ps`), printed it under `bash -x`, and the server wrote the keys
# file world-readable before a chmod.
#
# - Every program set-key.sh starts goes through a shim that records its arguments and environment;
#   `az` is a stand-in that also records what its @file holds.
# - The value and its base64 must not appear in any of those, in the output, or in a `bash -x` trace.
# - The temporary file must be private and gone afterwards, also when az fails or set-key.sh is killed.
# - The script the server would run is run here against a copy of /opt/concord under umask 022.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# --- stand-ins -------------------------------------------------------------------------------
mkdir -p "$work/stub" "$work/shim"
cat > "$work/stub/az" <<'EOF'
#!/bin/bash
for a in "$@"; do
  printf '%s\n' "$a" >> "$AZ_LOG/exec"
  if [[ "$a" == @* ]]; then
    f=${a#@}
    { stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f"; } > "$AZ_LOG/mode"
    printf '%s\n' "$f" > "$AZ_LOG/path"
    cat "$f" > "$AZ_LOG/script"
  fi
done
export -p >> "$AZ_LOG/exec"
case "${AZ_MODE:-}" in
  fail) echo "az: something went wrong" >&2; exit 1 ;;
  kill) kill -TERM "$PPID"; exit 0 ;;
esac
echo "updated"
EOF
chmod +x "$work/stub/az"

# One shim per program on PATH: it logs its argv and exported environment, then runs the real one.
cat > "$work/shim.sh" <<'EOF'
#!/bin/bash
n=${0##*/}
# Each process gets its own log: base64 and tr run at once in a pipeline, and appending to one
# shared file interleaved their lines.
{ printf '%s' "$n"; printf ' %s' "$@"; printf '\n'; export -p; } >> "$AZ_LOG/exec.$$"
IFS=: read -ra dirs <<< "$REAL_PATH"
for d in "${dirs[@]}"; do [[ -x "$d/$n" && ! -d "$d/$n" ]] && exec "$d/$n" "$@"; done
echo "shim: $n not found" >&2; exit 127
EOF
chmod +x "$work/shim.sh"
IFS=: read -ra dirs <<< "$PATH"
for d in "${dirs[@]}"; do
  [[ -d "$d" ]] || continue
  for f in "$d"/*; do
    n=${f##*/}
    [[ -x "$f" && ! -d "$f" && "$n" != az && ! -e "$work/shim/$n" ]] && ln -s "$work/shim.sh" "$work/shim/$n"
  done
done

secret="s3cr3t-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
encoded=$(printf %s "$secret" | base64 | tr -d '\n')

# run [bash options...] -- NAME VALUE -> set-key.sh's exit status; logs in $work/log
run() {
  local opts=()
  while [[ "$1" != -- ]]; do opts+=("$1"); shift; done; shift
  rm -rf "$work/log"; mkdir -p "$work/log"; : > "$work/log/exec"
  printf '%s\n' "$2" | env AZ_LOG="$work/log" REAL_PATH="$PATH" PATH="$work/stub:$work/shim" \
    ${INHERIT_SHELLOPTS:+SHELLOPTS="$INHERIT_SHELLOPTS"} bash ${opts[@]+"${opts[@]}"} "$here/set-key.sh" "$1" > "$work/log/out" 2> "$work/log/err"
}
not_exposed() { # the value and its base64 appear nowhere we can see
  for f in "$work/log"/exec* "$work/log/out" "$work/log/err"; do
    grep -qF -- "$secret" "$f" && fail "$1: the secret appeared in ${f##*/}"
    grep -qF -- "$encoded" "$f" && fail "$1: the base64 of the secret appeared in ${f##*/}"
  done
  return 0
}
temp_removed() { [[ ! -e "$(cat "$work/log/path")" ]] || fail "$1: the temporary file was left behind"; }

# --- the local side --------------------------------------------------------------------------
run -- ANTHROPIC_API_KEY "$secret" || fail "set-key.sh exited non-zero: $(cat "$work/log/err")"
grep -q '^@' "$work/log/exec" || fail "az was not called with a script file"
grep -qh '^base64' "$work/log"/exec.* || fail "the shims didn't see base64 run (are they working?)"
not_exposed "plain run"
[[ "$(cat "$work/log/mode")" == 600 ]] || fail "the script file was readable by others (mode $(cat "$work/log/mode"))"
grep -qF -- "$encoded" "$work/log/script" || fail "the script file did not carry the value"
temp_removed "plain run"
cp "$work/log/script" "$work/remote.sh"

run -x -- ANTHROPIC_API_KEY "$secret" || fail "set-key.sh under bash -x exited non-zero"
not_exposed "bash -x"
INHERIT_SHELLOPTS=xtrace run -- ANTHROPIC_API_KEY "$secret" || fail "set-key.sh with xtrace inherited exited non-zero"
not_exposed "inherited xtrace"

AZ_MODE=fail run -- ANTHROPIC_API_KEY "$secret" && fail "a failing az was reported as success"
not_exposed "az failing"; temp_removed "az failing"
AZ_MODE=kill run -- ANTHROPIC_API_KEY "$secret" && fail "set-key.sh reported success after being killed"
not_exposed "killed"; temp_removed "killed"

# Refusals happen before anything is sent.
run -- FEEDBACK_TRIAGE_TOKEN short && fail "a short triage token was accepted"
grep -q '^@' "$work/log/exec" && fail "az was called for a refused token"
run -- lower_case "$secret" && fail "a lower-case key name was accepted"
run -- ANTHROPIC_API_KEY "" && fail "an empty value was accepted"
grep -q '^@' "$work/log/exec" && fail "az was called for an empty value"

# --- the server side -------------------------------------------------------------------------
# Run the script az would have sent against a copy of /opt/concord, with a umask that would make
# new files world-readable. `grep` and `mv` record how private the new file is when the keys are
# written and when it is swapped in; `mv` can also be made to fail.
grep -q '^cd /opt/concord$' "$work/remote.sh" || fail "the server script no longer starts in /opt/concord"
mkdir -p "$work/srv" "$work/srvbin"
cat > "$work/srvbin/mv" <<EOF
#!/bin/bash
{ stat -c '%a' "\$1" 2>/dev/null || stat -f '%Lp' "\$1"; } > "$work/srv-mv-mode"
[[ -z "\${MV_FAIL:-}" ]] || exit 1
exec "$(command -v mv)" "\$@"
EOF
# grep writes the existing keys into the new file, so record how private that file is right then:
# the mode of every file in the directory except keys.env itself. (Statting /dev/stdout instead
# gave the descriptor's mode on macOS, not the file's.)
cat > "$work/srvbin/grep" <<EOF
#!/bin/bash
for f in "$work/srv"/* "$work/srv"/.[!.]*; do
  [[ -f "\$f" && "\${f##*/}" != keys.env ]] || continue
  { stat -c '%a' "\$f" 2>/dev/null || stat -f '%Lp' "\$f"; }
done > "$work/srv-grep-mode"
exec "$(command -v grep)" "\$@"
EOF
printf '#!/bin/sh\necho "$@" > "%s"\n' "$work/srv-systemctl" > "$work/srvbin/systemctl"
chmod +x "$work/srvbin/mv" "$work/srvbin/grep" "$work/srvbin/systemctl"
sed "s#^cd /opt/concord\$#cd '$work/srv'#" "$work/remote.sh" > "$work/remote-local.sh"
server() { (umask 022; PATH="$work/srvbin:$PATH" sh "$work/remote-local.sh") > "$work/srv-out" 2>&1; }
leftovers() { ls -A "$work/srv" | grep -v '^keys.env$' || true; }

printf 'OTHER=1\nANTHROPIC_API_KEY=old\n' > "$work/srv/keys.env"; chmod 600 "$work/srv/keys.env"
server || fail "the server script failed: $(cat "$work/srv-out")"
[[ "$(cat "$work/srv/keys.env")" == "$(printf 'OTHER=1\nANTHROPIC_API_KEY=%s' "$secret")" ]] || fail "the server's keys file is wrong"
[[ "$(cat "$work/srv-grep-mode")" == 600 ]] || fail "the new keys file was readable by others while the keys were written (mode $(cat "$work/srv-grep-mode"))"
[[ "$(cat "$work/srv-mv-mode")" == 600 ]] || fail "the new keys file was readable by others before the swap"
[[ "$(mode "$work/srv/keys.env")" == 600 ]] || fail "the keys file isn't private"
[[ -z "$(leftovers)" ]] || fail "the server script left $(leftovers) behind"
grep -q 'start concord-refresh.service' "$work/srv-systemctl" || fail "the server script didn't apply the key"
grep -qF -- "$secret" "$work/srv-out" && fail "the server script printed the secret"

printf 'OTHER=1\nANTHROPIC_API_KEY=old\n' > "$work/srv/keys.env"
MV_FAIL=1 server && fail "the server script ignored a failed swap"
[[ "$(cat "$work/srv/keys.env")" == "$(printf 'OTHER=1\nANTHROPIC_API_KEY=old')" ]] || fail "a failed swap changed the keys file"
[[ -z "$(leftovers)" ]] || fail "a failed swap left $(leftovers) behind"

echo "set-key.sh keeps the value out of command lines, environments, traces and readable files: ok"
