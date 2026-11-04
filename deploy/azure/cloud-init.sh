#!/bin/bash
# First-boot setup for the Concord backend on an Azure Ubuntu 24.04 VM.
# deploy.sh fills in the __PLACEHOLDERS__ and passes this file as the VM's custom data.
set -euxo pipefail
mkdir -p /opt/concord
cat > /opt/concord/stack.env <<EOT
HOST=__HOST__
IMAGE=__IMAGE__
PUBLIC_URL=__PUBLIC_URL__
EOT

# 4 GB swap: the smallest VM has 1 GB of RAM, shared by Node, the Solid server and HermiT (Java).
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi
swapon -a || true

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 python3 curl jq
systemctl enable --now docker

[ -f /opt/concord/session.secret ] || openssl rand -hex 32 > /opt/concord/session.secret
chmod 600 /opt/concord/session.secret

# API keys and settings. set-key.sh edits this file; refresh.sh reads it every five minutes.
if [ ! -f /opt/concord/keys.env ]; then
  cat > /opt/concord/keys.env <<EOT
ADMIN_EMAILS=__ADMIN_EMAILS__
DEMO_MODE=1
ALLOW_PUBLIC_RESET=0
EOT
fi
chmod 600 /opt/concord/keys.env

cat > /opt/concord/Caddyfile <<'EOT'
{$HOST} {
  encode gzip
  reverse_proxy concord:8787 {
    flush_interval -1
  }
}
pods.{$HOST} {
  reverse_proxy solid:3000
}
EOT

cat > /opt/concord/compose.yaml <<'EOT'
services:
  concord:
    image: ${IMAGE}
    restart: unless-stopped
    env_file: [app.env]
    volumes: [concord-data:/data]
    depends_on: [solid]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
  solid:
    image: solidproject/community-server:7
    restart: unless-stopped
    command: ["-c", "@css:config/file.json", "-f", "/data", "-b", "https://pods.${HOST}/"]
    volumes: [solid-data:/data]
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment: ["HOST=${HOST}"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]
volumes:
  concord-data:
  solid-data:
  caddy-data:
  caddy-config:
EOT

# Writes app.env from keys.env, pulls a newer image if there is one and (re)starts the stack.
# Runs at boot and every five minutes: that is the deploy.
cat > /opt/concord/refresh.sh <<'EOT'
#!/bin/bash
set -euo pipefail
cd /opt/concord
set -a; . ./stack.env; set +a
{
  echo "PUBLIC_URL=$PUBLIC_URL"
  echo "WEB_URL=$PUBLIC_URL"
  echo "SOLID_SERVER_URL=https://pods.$HOST"
  echo "SESSION_SECRET=$(cat session.secret)"
  grep -E '^[A-Z_][A-Z0-9_]*=.+' keys.env | grep -v '^GHCR_' || true
} > app.env.tmp
chmod 600 app.env.tmp && mv app.env.tmp app.env
token=$(sed -n 's/^GHCR_TOKEN=//p' keys.env)
if [ -n "$token" ]; then
  user=$(sed -n 's/^GHCR_USER=//p' keys.env)
  echo "$token" | docker login ghcr.io -u "${user:-x}" --password-stdin >/dev/null
fi
docker compose --env-file stack.env pull -q
docker compose --env-file stack.env up -d --remove-orphans
docker image prune -f >/dev/null
EOT
chmod 700 /opt/concord/refresh.sh

# Daily incremental snapshot of the OS disk (database, ontology git history, pods), kept for 14 days.
# Uses the VM's managed identity, which deploy.sh scopes to this resource group.
cat > /opt/concord/snapshot.sh <<'EOT'
#!/bin/bash
set -euo pipefail
imds=http://169.254.169.254/metadata
token=$(curl -sf -H Metadata:true "$imds/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/" | jq -r .access_token)
compute=$(curl -sf -H Metadata:true "$imds/instance/compute?api-version=2021-02-01")
disk=$(jq -r .storageProfile.osDisk.managedDisk.id <<<"$compute")
location=$(jq -r .location <<<"$compute")
rg=$(jq -r .resourceGroupName <<<"$compute")
sub=$(jq -r .subscriptionId <<<"$compute")
api=https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Compute/snapshots
name=concord-$(date -u +%Y%m%d)
curl -sf -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$api/$name?api-version=2023-10-02" \
  -d "{\"location\":\"$location\",\"tags\":{\"concord-backup\":\"daily\"},\"sku\":{\"name\":\"Standard_LRS\"},\"properties\":{\"incremental\":true,\"creationData\":{\"createOption\":\"Copy\",\"sourceResourceId\":\"$disk\"}}}" >/dev/null
cutoff=$(date -u -d '14 days ago' +%Y%m%d)
curl -sf -H "Authorization: Bearer $token" "$api?api-version=2023-10-02" \
  | jq -r '.value[] | select(.tags["concord-backup"]=="daily") | .name' \
  | while read -r old; do
      if [[ "${old#concord-}" < "$cutoff" ]]; then
        curl -sf -X DELETE -H "Authorization: Bearer $token" "$api/$old?api-version=2023-10-02" >/dev/null
      fi
    done
EOT
chmod 700 /opt/concord/snapshot.sh

cat > /etc/systemd/system/concord-refresh.service <<'EOT'
[Unit]
Description=Pull the latest Concord image and configuration
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/concord/refresh.sh
EOT
cat > /etc/systemd/system/concord-refresh.timer <<'EOT'
[Unit]
Description=Check for Concord updates every five minutes
[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOT
cat > /etc/systemd/system/concord-snapshot.service <<'EOT'
[Unit]
Description=Snapshot the Concord disk
[Service]
Type=oneshot
ExecStart=/opt/concord/snapshot.sh
EOT
cat > /etc/systemd/system/concord-snapshot.timer <<'EOT'
[Unit]
Description=Daily Concord disk snapshot
[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOT
systemctl daemon-reload
systemctl enable concord-refresh.timer concord-snapshot.timer
/opt/concord/refresh.sh
systemctl start concord-refresh.timer concord-snapshot.timer
