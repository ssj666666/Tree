# Tree Step 3.4 — One virtual screen per bot (bot-hq model)

Date: 2026-11-16. Status: built and verified on the dev machine.
**Not yet deployed to the Alibaba Cloud server and not yet pushed to
GitHub** — code left uncommitted for review; deploy with the normal flow
(push → server pulls → `bash deploy.sh` → `systemctl restart tree`).
No new keys are needed; `.env` needs no changes.
**Note for the push: this step changes only already-tracked files,
except the new `STEP3.4-NOTES.md` itself — `git add` it before pushing
(the API push helper only pushes tracked files).**

## What was built

Tier 2 of "each bot its own computer": one server, one virtual screen
per bot — the same model as Nick's Bot HQ (one computer, one screen per
bot), not separate VMs (that is a later tier).

### 1. Virtual displays (Xvfb)

- Display mapping (base from `TREE_XVFB_BASE_DISPLAY`, default 11):
  **Quinn :11 · Scout :12 · Forge :13 · Ledger :14 · Brief :15**.
  Unknown bot names share fallback display :19 (base + 8).
- `deploy.sh` step 4d (new, guarded — its failure never kills the
  deploy): installs Xvfb + fonts, writes `/root/tree/bin/xvfb-start.sh`
  (starts Xvfb on :11–:15 if not already running, then waits), writes
  `/etc/systemd/system/tree-xvfb.service` (Type=simple,
  ExecStart=xvfb-start.sh, Restart=on-failure, RestartSec=5),
  enables + starts it, and smoke-tests each display by checking for its
  socket `/tmp/.X11-unix/X<n>`. The unit restarts the displays on
  server reboot.
- dnf package names (Alibaba Cloud Linux 3, from RHEL packaging
  knowledge — **UNVERIFIED on the server until step 4d runs there**):
  `xorg-x11-server-Xvfb xorg-x11-utils xorg-x11-fonts-misc
  xorg-x11-fonts-Type1 dejavu-sans-fonts liberation-fonts`.
  apt side (Debian/Ubuntu): `xvfb x11-utils fonts-liberation
  fonts-dejavu-core`. The smoke test (socket check) is the real check,
  not the package list.

### 2. One browser profile per bot

- `data/browser-profiles/<bot>/` (git-ignored): Quinn → `quinn`,
  Scout → `scout`, etc. (bot name lowercased, sanitised).
  Logins/cookies persist per bot across restarts — that persistence is
  the point of this step. No credentials are stored anywhere else.
- Profiles live under `data/`, which is git-ignored, so a code re-sync
  never wipes them. **Caveat:** `deploy.sh`'s tarball fallback
  (`sync_from_tarball`) does `rm -rf /root/tree` and preserves only
  `.env` — if the server ever falls back to a tarball re-sync, the
  profiles (and the database) are wiped. Normal path is `git pull`,
  which preserves `data/`. Preserving `data/` in the tarball path is
  a future fix, not part of this step.

### 3. browse_page on the bot's own screen

- `server/src/agent/browsertools.ts` reworked: `browsePage(url, bot)`
  now launches **headed Chromium** (`headless: false`) on the calling
  bot's DISPLAY with its persistent profile
  (`chromium.launchPersistentContext`). If the bot's display is not
  running, it falls back to headless mode and says so in the result
  (graceful degradation, never a crash).
- Every browse saves a screenshot to
  `data/screenshots/<bot>-latest.png` and notes the screen + path in
  the returned text. Every launch + screenshot is logged to
  `data/tool-calls.log` (bot, display, headed true/false, outcome).
- **Browsers launch ON DEMAND per call and close afterwards — NOT 24/7.**
  Only the Xvfb displays run persistently. This is the RAM policy for
  the 2C4G server (see measurements below).
- `server/src/agent/tools.ts`: `browse_page` now passes the calling
  bot's id + name through; new tool `take_screenshot` (no parameters)
  re-opens the bot's last browsed URL on its own screen and saves a
  screenshot to `data/screenshots/<bot>-latest.png`, returning the path.
  If the bot has not browsed anything yet, it says so.
- `server/src/agent/prompt.ts`: steering updated — each bot has its own
  screen + profile; `take_screenshot` exists for "show me your screen";
  no user takeover yet.
- `server/src/env.ts` + `.env.example`: new optional
  `TREE_XVFB_BASE_DISPLAY` (default 11).

## What was verified (dev server, port 8787, DEV_LOGIN=1, real DeepSeek key)

`npm run typecheck` ✅, `npm run build` ✅, `bash -n deploy.sh` ✅.
Xvfb :11 and :12 started on the dev VM (Ubuntu 24.04, Xvfb already
installed). Two local test pages on 127.0.0.1:8899 — `/red.html`
(red background, "QUINN RED PAGE") and `/blue.html` (blue background,
"SCOUT BLUE PAGE").

- **(a) Quinn opens red** — asked Quinn to open the red page itself
  (not delegate). It reported title "QUINN RED PAGE", headline
  "红色警报演习成功", screen **:11**, screenshot saved to
  `data/screenshots/quinn-latest.png`. Tool log:
  `browse_page quinn display=11 headed=True ok=True`.
- **(b) Scout opens blue** — Scout reported title "SCOUT BLUE PAGE",
  headline "蓝色海洋考察完成", screen **:12**, screenshot saved.
  Tool log: `browse_page scout display=12 headed=True ok=True`.
  Scout also called `take_screenshot` itself afterwards (log:
  `take_screenshot scout display=12 headed=True ok=True`).
- **(c) Screenshots visually confirmed different** — read both PNGs
  (1280×800 each): Quinn's is a red page reading "QUINN RED PAGE /
  这是红色测试页，专给 Quinn 打开。头条：红色警报演习成功。";
  Scout's is a blue page reading "SCOUT BLUE PAGE / 这是蓝色测试页，
  专给 Scout 打开。头条：蓝色海洋考察完成。" Chinese text renders
  correctly (Noto fonts on the dev VM).
- **(d) Profile directories created** — `data/browser-profiles/quinn/`
  and `data/browser-profiles/scout/` each contain a real Chromium
  profile (Default, Local State, Safe Browsing, etc.).
- **(e) Headless fallback (graceful degradation)** — killed Xvfb :12,
  asked Scout to open the blue page again. It reported: "这次是无头模
  式（headless）打开的，不是在我自己的虚拟屏 :12 上。页面照常抓到
  了……工具这次明确报的是「虚拟屏 :12 未启动，本次用无头模式打
  开」；截图仍保存了。" Tool log confirms:
  `browse_page scout display=12 headed=False ok=True` and
  `take_screenshot scout display=12 headed=False ok=True`. Scout even
  offered to check why Xvfb was down. The fallback works exactly as
  designed.
- Test server stopped afterwards; test data deleted (`data/` in the
  project and in /root/tree, cookies, logs, temp test pages), so the
  first real login stays fresh.

## RAM notes for the 2C4G server (measured on the dev VM)

- Xvfb: **~14 MB RSS per display** (measured) → five displays ≈ 70 MB
  idle. Cheap.
- Headed Chromium: one instance with a simple page open measured
  **~1,025 MB summed RSS across 12 chrome processes**. Summed RSS
  overcounts shared memory (shared libraries counted once per process),
  so unique memory is lower — but the order of magnitude is real:
  headed Chromium is far heavier than headless (~200–300 MB).
- Consequence: on a 2C4G server, **do not let several bots browse
  headed at the same time for long**. The on-demand + close-after-use
  policy bounds this (one browser at a time in normal use). If headed
  browsing becomes a memory problem, the options are: fall back to
  headless for routine browsing (lighter), or add RAM to the server.
  The 4c headless smoke test is unaffected.

## Known limits

- **No user takeover yet** — the user cannot drive a bot's screen with
  their own mouse/keyboard, and there is no VNC/RDP attached to the
  virtual displays. Screenshots are one-way (bot → user). Takeover is
  explicitly future work.
- **Xvfb displays are virtual** — nobody can "see" them without a
  screenshot; they exist so each bot has an isolated headed browser.
- **dnf package names unverified on the server** until step 4d runs
  there (guarded; the socket smoke test is the real check).
- **External browsing on the server is still untested** (same as step
  3.2): the dev VM's egress proxy refuses Chromium's CONNECT, so E2E
  used local test pages. After deploy, verify with a real page
  (e.g. ask Quinn to open https://www.zhihu.com/hot).
- **Tarball re-sync wipes profiles — FIXED 2026-11-16 (unpushed):**
  `sync_from_tarball` in `deploy.sh` now backs up `/root/tree/data`
  (SQLite DB, browser profiles, screenshots) to `/tmp` before `rm -rf`
  and restores it after extraction, alongside the existing `.env` backup;
  verified in a sandbox (`.env` + DB + profile + screenshot all survive,
  new code still lands, no-`data/` case also passes, `bash -n` clean).
  Still unpushed — the next deploy must pick up this fix before the
  fallback path can ever run. The normal git-pull path was always safe.
- Forge / Ledger / Brief bots do not exist yet in Tree; their displays
  (:13–:15) and profile slots are reserved and will work automatically
  when the bots are created.
- Testing note: `pkill -f "Xvfb :12"` matches the shell's own command
  line and kills it too — use `pkill -f "^Xvfb :12"` instead. (Bit me
  during the fallback test; the display still died as intended.)

## 2026-11-16 evening fix — step 4c installed only headless shell (found on the server)

After the user deployed commit 06810a1, Quinn reported: `browse_page`
could only use the headless shell; the full Chromium binary
(`chromium-1255/chrome-linux64/chrome`) was missing, so headed launches
on the bots' virtual screens failed and browse_page fell back to
headless. Root cause: step 4c of `deploy.sh` installed ONLY
`chromium-headless-shell` — written in step 3.2, before headed browsing
existed. Fix (local, unpushed at time of writing): step 4c now installs
BOTH `chromium` (full build, needed for headed mode) and
`chromium-headless-shell`, npmmirror first, official CDN fallback, and
adds a smoke check that the full binary actually exists
(`chromium.executablePath()` + `fs.existsSync`, prints
`full chromium ok: <path>`). Verified: `bash -n deploy.sh` passes; the
check prints `full chromium ok` on the dev VM (which has the full
build). The same push also carries the tarball data-backup fix from
2026-11-16 14:04 (unpushed at the time). One re-deploy picks up both.

## What the user must do on the server (after review and push)

Re-run `deploy.sh` (step 4d installs Xvfb + starts the displays via
the tree-xvfb service), then `systemctl restart tree`. No `.env`
changes needed. Then test: ask Quinn to open a page and take a
screenshot; ask Scout to open a different page — the two screenshots
should show different pages.
