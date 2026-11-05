#!/bin/bash
# Launches the Concord backend on Azure: one small Ubuntu VM running the API, MCP endpoint,
# governance clock, live meeting streams, HermiT and a Solid server behind Caddy (HTTPS).
# Run after `az login`. Safe to re-run: it reuses what already exists.
#
#   PUBLIC_URL=https://standards-concord.vercel.app ADMIN_EMAILS=you@example.org ./deploy/azure/deploy.sh
#
# Optional: RESOURCE_GROUP (concord), LOCATION (uksouth), VM_SIZE (Standard_B2ats_v2, free for
# 12 months on Azure for Students; Standard_B2als_v2 has 4 GB of RAM), IMAGE.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${PUBLIC_URL:?Set PUBLIC_URL to the Vercel URL, with no trailing slash}"
RESOURCE_GROUP=${RESOURCE_GROUP:-concord}
LOCATION=${LOCATION:-uksouth}
VM_SIZE=${VM_SIZE:-Standard_B2ats_v2}
IMAGE=${IMAGE:-ghcr.io/standards-concord/standards-concord:latest}
ADMIN_EMAILS=${ADMIN_EMAILS:-}
ADMIN_WEBIDS=${ADMIN_WEBIDS:-}
VM=concord

echo "Subscription: $(az account show --query name -o tsv)"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

az network public-ip create -g "$RESOURCE_GROUP" -n concord-ip --sku Standard --allocation-method Static -o none
ip=$(az network public-ip show -g "$RESOURCE_GROUP" -n concord-ip --query ipAddress -o tsv)
host="$ip.sslip.io"

# The firewall is (re)applied on every run, so a re-run after a failed launch still opens 80 and 443.
az network nsg create -g "$RESOURCE_GROUP" -n concord-nsg -l "$LOCATION" -o none
az network nsg rule create -g "$RESOURCE_GROUP" --nsg-name concord-nsg -n web --priority 100 \
  --access Allow --protocol Tcp --destination-port-ranges 80 443 -o none

if ! az vm show -g "$RESOURCE_GROUP" -n "$VM" -o none 2>/dev/null; then
  custom=$(mktemp)
  sed -e "s|__HOST__|$host|" -e "s|__IMAGE__|$IMAGE|" -e "s|__PUBLIC_URL__|$PUBLIC_URL|" \
    -e "s|__ADMIN_EMAILS__|$ADMIN_EMAILS|" -e "s|__ADMIN_WEBIDS__|$ADMIN_WEBIDS|" "$here/cloud-init.sh" > "$custom"
  # No SSH port is opened; use `az vm run-command` (see docs/deploy.md) for shell access.
  az vm create -g "$RESOURCE_GROUP" -n "$VM" --size "$VM_SIZE" \
    --image Canonical:ubuntu-24_04-lts:server:latest \
    --os-disk-size-gb 64 --storage-sku Premium_LRS \
    --public-ip-address concord-ip --nsg concord-nsg --nsg-rule NONE \
    --admin-username concord --generate-ssh-keys \
    --assign-identity --role Contributor --scope "$(az group show -n "$RESOURCE_GROUP" --query id -o tsv)" \
    --custom-data "$custom" -o none
  rm -f "$custom"
fi

echo
echo "BackendUrl:     https://$host"
echo "SolidServerUrl: https://pods.$host"
echo "Set BACKEND_URL=https://$host in Vercel and redeploy. The server needs a few minutes to start."
