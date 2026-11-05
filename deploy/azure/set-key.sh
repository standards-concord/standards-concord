#!/bin/bash
# Adds or changes one key on the Concord server, e.g. ./deploy/azure/set-key.sh ANTHROPIC_API_KEY
# The value is read without echoing it (or from stdin when piped). The server applies it within five minutes.
#
# The value never appears in a command line, where `ps` or shell history could show it: it is written
# to a private temporary file that `az` reads with its @file syntax, and deleted afterwards.
# deploy/azure/set-key.test.sh checks this.
set -euo pipefail
name=${1:?Usage: set-key.sh NAME}
[[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "Key names are upper case, like ANTHROPIC_API_KEY" >&2; exit 1; }
RESOURCE_GROUP=${RESOURCE_GROUP:-concord}
IFS= read -rsp "$name: " value || true
[[ -t 0 ]] && echo
[[ -n "$value" ]] || { echo "No value given for $name" >&2; exit 1; }
# Shared secrets the server checks itself must be long and random; the server ignores a shorter one.
if [[ "$name" == FEEDBACK_TRIAGE_TOKEN && ${#value} -lt 32 ]]; then
  echo "$name must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

umask 077
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# printf is a shell builtin, so the value isn't passed to another program's arguments here either.
encoded=$(printf %s "$value" | base64 | tr -d '\n')
unset value
cat > "$dir/script.sh" <<EOF
set -e
cd /opt/concord
v=\$(printf %s '$encoded' | base64 -d)
grep -v '^$name=' keys.env > keys.tmp || true
printf '%s=%s\n' '$name' "\$v" >> keys.tmp
chmod 600 keys.tmp
mv keys.tmp keys.env
systemctl start concord-refresh.service
echo updated $name
EOF
unset encoded
az vm run-command invoke -g "$RESOURCE_GROUP" -n concord --command-id RunShellScript --query 'value[0].message' -o tsv \
  --scripts @"$dir/script.sh"
