#!/bin/bash
# Tree deploy script — run as root on the Alibaba Cloud server.
# Works on any Linux (Debian/Ubuntu and RHEL/Alibaba Cloud Linux alike).
# China-network resilient: every download tries the overseas source first,
# then falls back to a domestic mirror (npmmirror / ghproxy / jsDelivr),
# because GitHub and nodejs.org are often unreachable from mainland servers.
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
  TARBALL="$(curl -fsSL --max-time 20 https://nodejs.org/dist/latest-v24.x/ 2>/dev/null | grep -o "node-v24[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -1 || true)"
  if [ -n "$TARBALL" ] && curl -fsSL --max-time 60 "https://nodejs.org/dist/latest-v24.x/${TARBALL}" -o /tmp/node.tar.xz; then
    echo "node from nodejs.org: $TARBALL"
  else
    echo "nodejs.org unreachable, trying npmmirror..."
    TARBALL="$(curl -fsSL --max-time 20 https://npmmirror.com/mirrors/node/latest-v24.x/ | grep -o "node-v24[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -1)"
    curl -fsSL --max-time 120 "https://npmmirror.com/mirrors/node/latest-v24.x/${TARBALL}" -o /tmp/node.tar.xz
    echo "node from npmmirror: $TARBALL"
  fi
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
sync_from_tarball() {
  # Fresh copy from a source tarball (used only when git cannot reach any
  # remote). Preserves /root/tree/.env if it already exists.
  [ -f /root/tree/.env ] && cp /root/tree/.env /tmp/tree-env-backup
  curl -fsSL --max-time 60 https://ghproxy.net/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main -o /tmp/tree.tar.gz
  rm -rf /root/tree
  mkdir -p /root/tree
  tar -xzf /tmp/tree.tar.gz -C /root/tree --strip-components=1
  [ -f /tmp/tree-env-backup ] && cp /tmp/tree-env-backup /root/tree/.env
  cd /root/tree
  echo "note: installed from tarball, no .git — future updates need a fresh download"
}
if [ -d /root/tree/.git ]; then
  cd /root/tree
  # github.com is often unreachable from mainland servers, so a failed
  # pull must NOT kill the script (set -e): try proxies, then tarball.
  if ! git pull --ff-only 2>/dev/null; then
    echo "github pull failed, trying ghproxy..."
    if ! git pull --ff-only https://ghproxy.net/https://github.com/ssj666666/Tree.git main 2>/dev/null; then
      echo "ghproxy pull failed, trying gh-proxy..."
      if ! git pull --ff-only https://gh-proxy.com/https://github.com/ssj666666/Tree.git main 2>/dev/null; then
        echo "pull failed everywhere, re-syncing from tarball..."
        sync_from_tarball
      fi
    fi
  fi
else
  CLONED=0
  for url in https://github.com/ssj666666/Tree.git https://ghproxy.net/https://github.com/ssj666666/Tree.git https://gh-proxy.com/https://github.com/ssj666666/Tree.git; do
    echo "trying clone: $url"
    if git clone "$url" /root/tree 2>/dev/null; then CLONED=1; break; fi
  done
  if [ "$CLONED" = "0" ]; then
    echo "git clone failed everywhere, trying source tarball via ghproxy..."
    sync_from_tarball
  fi
  cd /root/tree
fi

echo "== 4. dependencies + build =="
npm config set registry https://registry.npmmirror.com
# The ignore-scripts setting in .npmrc works on npm 11/12 (verified against
# npm 12.2.2): it stops packages running install scripts during npm ci
# (better-sqlite3 ships a linux-x64 prebuild, handled in step 4b).
printf 'ignore-scripts=true\n' > .npmrc
npm ci

echo "== 4b. better-sqlite3 on old glibc =="
# better-sqlite3 13.0.3 ships a prebuilt binary that needs glibc 2.33, but
# Alibaba Cloud Linux 3 only has glibc 2.32, so the service crash-loops on
# start (seen 2026-11-16: "GLIBC_2.33 not found", restart counter 14).
# On such systems rebuild it from source and hide the prebuild, because
# v13.0.3 prefers the prebuild over a fresh build. A plain
# "node-gyp rebuild" is a no-op while the prebuild exists, so
# --force_build=1 is required; and require() alone does not prove the
# native module loads — only constructing a real Database does.
GLIBC_VER="$(ldd --version 2>/dev/null | head -1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*' | head -1)"
GLIBC_OK=0
if [ -n "$GLIBC_VER" ]; then
  GLIBC_MAJOR="${GLIBC_VER%%.*}"; GLIBC_MINOR="${GLIBC_VER##*.}"
  if [ "$GLIBC_MAJOR" -gt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -ge 33 ]; }; then GLIBC_OK=1; fi
fi
if [ "$GLIBC_OK" = "1" ]; then
  echo "glibc $GLIBC_VER >= 2.33, prebuilt better-sqlite3 works as-is"
else
  echo "glibc ${GLIBC_VER:-unknown} < 2.33, rebuilding better-sqlite3 from source..."
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y python3.11 gcc-c++ make || dnf install -y python3 gcc-c++ make
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y python3 gcc g++ make
  fi
  PYBIN="$(command -v python3.11 || command -v python3)"
  cd node_modules/better-sqlite3
  NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node npx --yes node-gyp rebuild --python="$PYBIN" --force_build=1
  if [ -f build/Release/better_sqlite3.node ] && [ -f prebuilds/linux-x64.node ]; then
    mv prebuilds/linux-x64.node prebuilds/linux-x64.node.bak
  fi
  cd /root/tree
  node -e "new (require('/root/tree/node_modules/better-sqlite3'))(':memory:'); console.log('sqlite ok')"
fi

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
