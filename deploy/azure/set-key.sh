#!/bin/bash
# Adds or changes one key on the Concord server, e.g. ./deploy/azure/set-key.sh ANTHROPIC_API_KEY
# The value is read without echoing it (or from stdin when piped). The server applies it within five minutes.
#
# The value never appears in a command line, the environment of another program, or a trace, where
# `ps`, process auditing or `bash -x` logs could show it. It is written to a private temporary file
# that `az` reads with its @file syntax, and deleted afterwards. On the server, the new keys file is
# private from the moment it is created. deploy/azure/set-key.test.sh checks all of this.
set +x # `bash -x set-key.sh` would otherwise print the value
set -euo pipefail
name=${1:?Usage: set-key.sh NAME}
[[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "Key names are upper case, like ANTHROPIC_API_KEY" >&2; exit 1; }
RESOURCE_GROUP=${RESOURCE_GROUP:-concord}

umask 077
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

IFS= read -rsp "$name: " value || true
[[ -t 0 ]] && echo
[[ -n "$value" ]] || { echo "No value given for $name" >&2; exit 1; }
# Shared secrets the server checks itself must be long and random; the server ignores a shorter one.
if [[ "$name" == FEEDBACK_TRIAGE_TOKEN && ${#value} -lt 32 ]]; then
  echo "$name must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

# printf is a shell builtin, so the value reaches base64 only on its stdin.
encoded=$(printf %s "$value" | base64 | tr -d '\n')
unset value
# The script the server runs. It makes the new keys file with mktemp (mode 0600) under umask 077,
# removes it on any exit, and only then swaps it in.
cat > "$dir/script.sh" <<EOF
set -e
umask 077
cd /opt/concord
tmp=\$(mktemp keys.env.XXXXXX)
trap 'rm -f "\$tmp"' EXIT
trap 'exit 1' HUP INT TERM
v=\$(printf %s '$encoded' | base64 -d)
grep -v '^$name=' keys.env > "\$tmp" || true
printf '%s=%s\n' '$name' "\$v" >> "\$tmp"
mv "\$tmp" keys.env
systemctl start concord-refresh.service
echo updated $name
EOF
unset encoded
az vm run-command invoke -g "$RESOURCE_GROUP" -n concord --command-id RunShellScript --query 'value[0].message' -o tsv \
  --scripts @"$dir/script.sh"
