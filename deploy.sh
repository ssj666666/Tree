#!/bin/bash
# Tree deploy script — run as root on the Alibaba Cloud server (Ubuntu 24.04).
# Installs Node.js 24 + git, clones (or updates) the Tree repo, installs
# dependencies, builds, and installs a systemd service (not started yet).
# It does NOT create .env. Create /root/tree/.env first, then start it:
#   systemctl start tree
# Check it with: systemctl status tree / curl http://localhost:8787/api/health
set -e
echo "== 1. Node.js 24 =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v
echo "== 2. git =="
command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git)
echo "== 3. code =="
if [ -d /root/tree/.git ]; then
  cd /root/tree && git pull --ff-only
else
  git clone https://github.com/ssj666666/Tree.git /root/tree
  cd /root/tree
fi
echo "== 4. dependencies + build =="
npm ci --ignore-scripts
npm run build
echo "== 5. systemd service =="
cat > /etc/systemd/system/tree.service <<'EOF'
[Unit]
Description=Tree personal agent
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=/root/tree
ExecStart=/usr/bin/npm run start -w server
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tree
echo "== deploy done =="
echo "Next: create /root/tree/.env, then run: systemctl start tree"
