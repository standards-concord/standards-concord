#!/bin/bash
# Adds or changes one key on the Concord server, e.g. ./deploy/azure/set-key.sh ANTHROPIC_API_KEY
# The value is read without echoing it. The server applies it within five minutes.
set -euo pipefail
name=${1:?Usage: set-key.sh NAME}
[[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "Key names are upper case, like ANTHROPIC_API_KEY" >&2; exit 1; }
RESOURCE_GROUP=${RESOURCE_GROUP:-concord}
read -rsp "$name: " value; echo
# Shared secrets the server checks itself must be long and random; the server ignores a shorter one.
if [[ "$name" == FEEDBACK_TRIAGE_TOKEN && ${#value} -lt 32 ]]; then
  echo "$name must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi
encoded=$(printf %s "$value" | base64 | tr -d '\n')
az vm run-command invoke -g "$RESOURCE_GROUP" -n concord --command-id RunShellScript --query 'value[0].message' -o tsv \
  --scripts "set -e; cd /opt/concord; v=\$(echo $encoded | base64 -d); grep -v '^$name=' keys.env > keys.tmp || true; printf '%s=%s\n' '$name' \"\$v\" >> keys.tmp; chmod 600 keys.tmp; mv keys.tmp keys.env; systemctl start concord-refresh.service; echo updated $name"
