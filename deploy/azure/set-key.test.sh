#!/bin/bash
# Checks that set-key.sh never puts the secret in a command line (where `ps`, audit logs or shell
# history could show it). It used to pass the base64 of the value inside `az --scripts "..."`.
# A stand-in `az` records its arguments and what any @file holds when it runs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/az" <<'EOF'
#!/bin/bash
for a in "$@"; do
  printf '%s\n' "$a" >> "$AZ_LOG/argv"
  if [[ "$a" == @* ]]; then
    f=${a#@}
    { stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f"; } > "$AZ_LOG/mode"
    printf '%s\n' "$f" > "$AZ_LOG/path"
    cat "$f" > "$AZ_LOG/script"
  fi
done
echo "updated"
EOF
chmod +x "$work/bin/az"

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { # run NAME VALUE -> exit status; logs in $work/log
  rm -rf "$work/log"; mkdir -p "$work/log"
  printf '%s\n' "$2" | AZ_LOG="$work/log" PATH="$work/bin:$PATH" bash "$here/set-key.sh" "$1" > "$work/log/out" 2> "$work/log/err"
}

secret="s3cr3t-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
encoded=$(printf %s "$secret" | base64 | tr -d '\n')

run ANTHROPIC_API_KEY "$secret" || fail "set-key.sh exited non-zero: $(cat "$work/log/err")"
[[ -s "$work/log/argv" ]] || fail "az was not called"
grep -qF -- "$secret" "$work/log/argv" && fail "the secret appeared in az's arguments"
grep -qF -- "$encoded" "$work/log/argv" && fail "the base64 of the secret appeared in az's arguments"
grep -qF -- "$secret" "$work/log/out" "$work/log/err" && fail "the secret was printed"
[[ "$(cat "$work/log/mode")" == 600 ]] || fail "the script file was readable by others (mode $(cat "$work/log/mode"))"
grep -qF -- "$encoded" "$work/log/script" || fail "the script file did not carry the value"
[[ ! -e "$(cat "$work/log/path")" ]] || fail "the script file was left behind"

# The script the server runs decodes back to exactly the value typed, and only touches that key.
grep -qF "grep -v '^ANTHROPIC_API_KEY=' keys.env" "$work/log/script" || fail "the script doesn't replace the key"
decoded=$(sed -n "s/^v=\$(printf %s '\(.*\)' | base64 -d)\$/\1/p" "$work/log/script" | base64 -d)
[[ "$decoded" == "$secret" ]] || fail "the value doesn't round-trip"

# Refusals still happen before anything is sent.
run FEEDBACK_TRIAGE_TOKEN short && fail "a short triage token was accepted"
[[ ! -e "$work/log/argv" ]] || fail "az was called for a refused token"
run lower_case "$secret" && fail "a lower-case key name was accepted"
run ANTHROPIC_API_KEY "" && fail "an empty value was accepted"
[[ ! -e "$work/log/argv" ]] || fail "az was called for an empty value"

echo "set-key.sh keeps the value out of command lines: ok"
