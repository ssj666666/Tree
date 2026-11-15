#!/bin/bash
# Tree deploy script — run as root on the Alibaba Cloud server.
# Works on any Linux (Debian/Ubuntu and RHEL/Alibaba Cloud Linux alike):
# Node.js comes from the official binary tarball, no package manager needed.
# Installs Node.js 24 + git, clones (or updates) the Tree repo, installs
# dependencies, builds, and installs a systemd service (not started yet).
# It does NOT create .env. Create /root/tree/.env first, then start it:
#   systemctl start tree
# Check it with: systemctl status tree / curl http://localhost:8787/api/health
set -e
echo "== 0. system =="
cat /etc/os-release 2>/dev/null | head -2 || true
uname -m
echo "== 1. Node.js 24 (official binary) =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o "node-v24[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -1)"
  echo "installing $TARBALL"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/${TARBALL}" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v
npm -v
echo "== 2. git =="
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    yum install -y git
  else
    echo "no supported package manager found, install git manually" >&2
    exit 1
  fi
fi
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
NPM_BIN="$(command -v npm)"
cat > /etc/systemd/system/tree.service <<EOF
[Unit]
Description=Tree personal agent
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=/root/tree
ExecStart=${NPM_BIN} run start -w server
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tree
echo "== deploy done =="
echo "Next: create /root/tree/.env, then run: systemctl start tree"
