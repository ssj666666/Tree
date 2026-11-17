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
  # remote). Preserves /root/tree/.env and /root/tree/data if they exist:
  # data/ holds the SQLite database, each bot's browser profile (logins)
  # and screenshots — wiping it would log every bot out and erase memory.
  # The tarball only contains git-tracked files and data/ is gitignored,
  # so the restore can never clash with extracted files.
  # 2026-11-17: ghproxy.net started returning 403 for the codeload
  # tarball, so try several proxies in turn and VERIFY the download is a
  # real gzip before touching /root/tree — a bad download must never wipe
  # the working install. The two proxies that answered 200 from the dev
  # VM are tried first; the server's network may favour different ones.
  rm -rf /tmp/tree-env-backup /tmp/tree-data-backup
  [ -f /root/tree/.env ] && cp /root/tree/.env /tmp/tree-env-backup
  [ -d /root/tree/data ] && cp -a /root/tree/data /tmp/tree-data-backup
  GOT_TARBALL=0
  for turl in \
    "https://gh-proxy.com/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" \
    "https://gh-proxy.org/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" \
    "https://ghproxy.net/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" \
    "https://mirror.ghproxy.com/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" \
    "https://ghfast.top/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" \
    "https://ghps.cc/https://codeload.github.com/ssj666666/Tree/tar.gz/refs/heads/main" ; do
    echo "trying tarball: $turl"
    if curl -fsSL --max-time 60 "$turl" -o /tmp/tree.tar.gz && tar -tzf /tmp/tree.tar.gz >/dev/null 2>&1; then
      echo "tarball ok from $turl"
      GOT_TARBALL=1
      break
    fi
    echo "tarball failed from $turl"
  done
  if [ "$GOT_TARBALL" = "0" ]; then
    echo "ERROR: all tarball mirrors failed — /root/tree left untouched, Tree keeps running the old version" >&2
    rm -rf /tmp/tree-env-backup /tmp/tree-data-backup
    exit 1
  fi
  rm -rf /root/tree
  mkdir -p /root/tree
  tar -xzf /tmp/tree.tar.gz -C /root/tree --strip-components=1
  [ -f /tmp/tree-env-backup ] && cp /tmp/tree-env-backup /root/tree/.env
  if [ -d /tmp/tree-data-backup ]; then mkdir -p /root/tree/data && cp -a /tmp/tree-data-backup/. /root/tree/data/; fi
  rm -rf /tmp/tree-env-backup /tmp/tree-data-backup
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
        echo "gh-proxy pull failed, trying gitclone..."
        if ! git pull --ff-only https://gitclone.com/github.com/ssj666666/Tree.git main 2>/dev/null; then
          echo "pull failed everywhere, re-syncing from tarball..."
          sync_from_tarball
        fi
      fi
    fi
  fi
else
  CLONED=0
  for url in https://github.com/ssj666666/Tree.git https://ghproxy.net/https://github.com/ssj666666/Tree.git https://gh-proxy.com/https://github.com/ssj666666/Tree.git https://gitclone.com/github.com/ssj666666/Tree.git; do
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

# tsc never deletes outputs of removed sources: wipe both dist dirs first,
# or deleted files (e.g. server/dist/orgo.js after step 4.2) would linger.
rm -rf server/dist web/dist
npm run build

echo "== 4c. Playwright browser (full Chromium + headless shell, for browse_page) =="
# Step 3.2 + 3.4: browse_page needs a real Chromium. Headed mode (each bot
# browses on its own virtual screen) needs the FULL Chromium build
# (chromium-*/chrome-linux64/chrome); headless mode uses the smaller
# headless-shell build. Step 4c used to install ONLY the headless shell,
# so headed launches failed with "Executable doesn't exist" and browse_page
# silently fell back to headless — that is the 2026-11-16 Zhihu bug
# (Quinn could screenshot, but only the login wall, and only headless).
# Install BOTH builds (npmmirror first, official CDN fallback).
# Playwright's install-deps/--with-deps only knows apt (Debian/Ubuntu),
# so on this dnf-based system install the runtime libraries by hand
# (package names mapped from Playwright's own rpm.deps for
# chromium-headless-shell), then download the browsers. npmmirror hosts a
# Playwright mirror, tried first because the official CDN is often
# slow/unreachable from mainland servers; the official CDN is the fallback.
# Browsers go to the default cache (~/.cache/ms-playwright), NOT inside
# /root/tree, so a code re-sync never wipes them. NOTHING here may kill
# the deploy (set -e): without a browser, browse_page just reports an
# error at runtime.
# glibc: the bundled Chromium 159 needs at most GLIBC_2.25 (verified
# 2026-11-16 with readelf), the server has glibc 2.32 — it should run.
# UNVERIFIED on the server until this step runs there.
if command -v dnf >/dev/null 2>&1; then
  dnf install -y epel-release 2>/dev/null || true
  dnf install -y nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib libxcb libX11 libXext libXcursor libXi gtk3 cairo pango libcurl liberation-fonts expat dbus-libs glib2 systemd-libs vulkan-loader wget xdg-utils ca-certificates 2>/dev/null || echo "WARNING: some Playwright system libraries failed to install — see the smoke test below"
elif command -v apt-get >/dev/null 2>&1; then
  npx playwright install-deps chromium-headless-shell 2>/dev/null || echo "WARNING: playwright install-deps failed — see the smoke test below"
fi
if ! PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium 2>/dev/null; then
  echo "npmmirror full-Chromium download failed, trying the official CDN..."
  npx playwright install chromium 2>/dev/null || echo "WARNING: full Chromium download failed — headed browsing unavailable, browse_page will fall back to headless"
fi
if ! PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium-headless-shell 2>/dev/null; then
  echo "npmmirror headless-shell download failed, trying the official CDN..."
  npx playwright install chromium-headless-shell 2>/dev/null || echo "WARNING: Playwright headless-shell download failed — browse_page will report an error until it is installed (re-run this step manually)"
fi
node --input-type=module -e "import('playwright').then(async ({chromium}) => { const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); await b.close(); console.log('browser ok'); }).catch((e) => { console.error('browser launch failed:', e.message); process.exit(1); })" 2>/dev/null || echo "WARNING: headless Chromium did not launch — browse_page will report an error (check the missing .so in the output above)"
node --input-type=module -e "import('playwright').then(async ({chromium}) => { const fs = await import('fs'); const p = chromium.executablePath(); console.log(fs.existsSync(p) ? 'full chromium ok: ' + p : 'WARNING: full Chromium binary missing at ' + p + ' — headed browsing unavailable, browse_page will fall back to headless'); })" 2>/dev/null || echo "WARNING: could not check the full Chromium binary"

echo "== 4d. Virtual screens (Xvfb, one display per bot) =="
# Step 3.4 (bot-hq model): each bot gets its own virtual display and its
# own persistent browser profile. Xvfb provides the displays; the browsers
# themselves launch on demand per task and close afterwards (one headed
# Chromium is ~300-400 MB while it runs; an idle Xvfb display is ~20-30 MB),
# so a 2C4G server can hold all five displays plus one or two browsers.
# Displays: Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15.
# A systemd unit (tree-xvfb) keeps the displays running across reboots.
# NOTHING here may kill the deploy (set -e): without Xvfb, browse_page
# falls back to headless mode at runtime and still works.
# Package names: dnf side is from RHEL/Alibaba Cloud Linux packaging
# knowledge (xorg-x11-server-Xvfb etc.) — UNVERIFIED on the server until
# this step runs there; the smoke test below is the real check.
if command -v dnf >/dev/null 2>&1; then
  dnf install -y xorg-x11-server-Xvfb xorg-x11-utils xorg-x11-fonts-misc xorg-x11-fonts-Type1 dejavu-sans-fonts liberation-fonts 2>/dev/null || echo "WARNING: some Xvfb packages failed to install — see the smoke test below"
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update && apt-get install -y xvfb x11-utils fonts-liberation fonts-dejavu-core 2>/dev/null || echo "WARNING: xvfb install failed — see the smoke test below"
fi
# Start script: one Xvfb per bot display, skipped if already up. The
# script waits, so the systemd unit stays alive while any display runs.
mkdir -p /root/tree/bin
cat > /root/tree/bin/xvfb-start.sh <<'EOS'
#!/bin/bash
# Tree virtual screens: Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15.
for d in 11 12 13 14 15; do
  if [ -S "/tmp/.X11-unix/X${d}" ]; then
    echo "display :${d} already running"
  else
    Xvfb ":${d}" -screen 0 1280x800x24 -ac >/tmp/xvfb-${d}.log 2>&1 &
    echo "started Xvfb :${d} (pid $!)"
  fi
done
wait
EOS
chmod +x /root/tree/bin/xvfb-start.sh
cat > /etc/systemd/system/tree-xvfb.service <<EOF
[Unit]
Description=Tree virtual screens (Xvfb, one display per bot)
After=network.target
[Service]
Type=simple
User=root
ExecStart=/root/tree/bin/xvfb-start.sh
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tree-xvfb 2>/dev/null || echo "WARNING: could not enable tree-xvfb (displays will not auto-start on reboot)"
systemctl restart tree-xvfb 2>/dev/null || systemctl start tree-xvfb 2>/dev/null || echo "WARNING: could not start tree-xvfb"
sleep 2
for d in 11 12 13 14 15; do
  if [ -S "/tmp/.X11-unix/X${d}" ]; then echo "display :${d} ok"; else echo "WARNING: display :${d} is not up — browse_page will fall back to headless mode"; fi
done

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
