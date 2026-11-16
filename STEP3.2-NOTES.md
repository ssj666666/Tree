# Tree Step 3.2 — Headless browser (`browse_page`)

Date: 2026-11-16. Status: built and verified on the dev machine.
**Not yet deployed to the Alibaba Cloud server and not yet pushed to
GitHub** — code left uncommitted for review; deploy with the normal flow
(push → server pulls → `bash deploy.sh` → `systemctl restart tree`).
No new keys are needed: the server's `.env` needs no changes
(`TREE_CHROMIUM_PATH` / `TREE_BROWSE_TIMEOUT_MS` are optional).

## What was built

`fetch_page` (step 3.1) only reads static HTML, so JS-heavy pages render
almost nothing there. Step 3.2 adds a real headless browser:

- **New tool `browse_page`** (`server/src/agent/browsertools.ts`,
  registered in `server/src/agent/tools.ts` for every bot, Quinn + Scout):
  opens a URL in a real Chromium (Playwright 1.65.1, headless), waits for
  JavaScript (`domcontentloaded` + up to ~15 s `networkidle` + 1.5 s
  settle), returns page title + rendered visible text (cap ~8000 chars) +
  up to 10 key links. Timeout budget from `TREE_BROWSE_TIMEOUT_MS`
  (default 60 s). Every call is logged to `data/tool-calls.log`
  (URL + outcome only), reusing step 3.1's `logCall` (now exported from
  `localtools.ts`).
- **Never throws:** unreachable/blocked/captcha/login-wall pages return a
  short Chinese notice (HTTP 403/401, captcha keywords, login-wall text,
  empty render, navigation errors), so the conversation never crashes.
- **Safety:** fresh browser context per call — no logins are filled in, no
  cookies or credentials are stored persistently, nothing is written to
  `.env` or any secret file. Runs as root, so Chromium gets `--no-sandbox`
  (same as headless CI). A proxy is used only if the standard
  `HTTPS_PROXY`/`HTTP_PROXY` env vars are set (the production server sets
  none — direct internet); loopback addresses (`localhost,127.0.0.1,::1`)
  always bypass the proxy (see the bug below).
- **Prompt steering** (`server/src/agent/prompt.ts`): use `browse_page`
  for JS-heavy pages and pages `fetch_page` cannot read; keep `fetch_page`
  for simple open pages; `browse_page` cannot log in, pass captchas, or
  read paywalled/member-only content — if it reports a block, tell the
  user instead of guessing.
- **Env** (`server/src/env.ts`, `.env.example`): optional
  `TREE_CHROMIUM_PATH` (use a system Chromium instead of Playwright's
  bundled one) and `TREE_BROWSE_TIMEOUT_MS` (default 60000). Both
  commented placeholders only — no real values.

## glibc finding (the question this step had to answer)

**The bundled Chromium should run on the production server.**
Evidence (dev VM, 2026-11-16), not guesses:

- Playwright 1.65.1 bundles Chromium 159.0.8154.6 (headless shell v1255).
- `readelf --version-info` on both the full `chrome` binary and the
  `chrome-headless-shell` binary: highest required symbol version is
  **GLIBC_2.25**, and there are **no GLIBCXX versioned symbols at all**.
  The headless shell's own `deb.deps` says `libc6 (>= 2.25)`.
- The production server has **glibc 2.32** — comfortably above 2.25.
  (Contrast: better-sqlite3's prebuild needed glibc 2.33 and broke there;
  Chromium does not have that problem.)
- **Still UNVERIFIED on the server** until deploy.sh step 4c runs there:
  the remaining risks are the system libraries and the browser download,
  both handled below, plus a launch smoke test in the deploy script.

## deploy.sh step 4c (new, guarded — its failure never kills the deploy)

1. System libraries — Playwright's `install-deps` / `--with-deps` only
   knows **apt** (Debian/Ubuntu), so on this dnf-based system the
   libraries are installed by hand, package names mapped from
   Playwright's own `rpm.deps` for `chromium-headless-shell`:
   `nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon
   libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib
   libxcb libX11 libXext libXcursor libXi gtk3 cairo pango libcurl
   liberation-fonts expat dbus-libs glib2 systemd-libs vulkan-loader
   wget xdg-utils ca-certificates` (plus an `epel-release` attempt).
   On apt systems it falls back to `npx playwright install-deps
   chromium-headless-shell`.
2. Browser download — `npx playwright install chromium-headless-shell`,
   first with `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`
   (npmmirror hosts a Playwright mirror — its index page shows a
   `builds/` directory; the exact per-build sub-path listing could not be
   fetched from here, so the step falls back to the official CDN if the
   mirror attempt fails).
3. Smoke test — launches the browser once (`chromium.launch`, headless,
   `--no-sandbox`) and prints `browser ok`; a failure prints a WARNING
   only. Browsers go to the default cache (`~/.cache/ms-playwright`,
   i.e. `/root/.cache/ms-playwright` for the service user), NOT inside
   `/root/tree`, so a code re-sync never wipes them.

## What was verified (dev server, port 8787, DEV_LOGIN=1, real DeepSeek key)

`npm run typecheck` ✅, `npm run build` ✅ (also after the final
timeout-wiring edit). Then a dev server with a fresh DeepSeek surrogate,
Quinn answering through the real API, against local test pages served on
`127.0.0.1:8899`:

- **(a) JS-rendered page** — a page whose news list is injected by JS
  (`setTimeout` 600 ms). Quinn called `browse_page` once and returned
  all three headlines verbatim. This proves real JavaScript rendering
  (the headlines do not exist in the static HTML at all).
- **(b) HTTP 403 page** — graceful Chinese notice ("HTTP 403，网站拒绝
  了访问…"), no crash.
- **(c) Captcha page** — rendered text was only "请完成人机验证…";
  Quinn correctly reported a captcha wall, no invented content.
- **(d) `https://www.zhihu.com/hot`** — graceful failure notice
  ("代理连接失败…网络出口限制了浏览器访问"). See the dev-VM
  limitation below: this is the VM's egress proxy refusing Chromium,
  not a tool bug. Zhihu hot on the production server is **untested**.
- **(e) `https://nonexistent-domain-xyz123.invalid/`** — graceful
  notice; Quinn even correctly explained `.invalid` is a reserved
  test-only TLD.
- Tool log (`data/tool-calls.log`) confirms all five calls with the
  expected outcomes. Test server stopped afterwards; test data deleted
  (`data/`, cookies, logs, temp test pages) so the first real login
  stays fresh.

## Bug found and fixed during verification (localhost proxy bypass)

First E2E run: `browse_page` on `http://127.0.0.1:8899/js-news` failed
with `net::ERR_EMPTY_RESPONSE`. Quinn then improvised (port-forward,
then installed `jsdom` and rendered the page with it — the headlines it
returned were correct, but that was a workaround, not the tool working).
Root cause: the Tree server inherits the dev VM's `HTTP(S)_PROXY` env
vars, and Chromium was sending even loopback requests through the
proxy, which cannot answer for `127.0.0.1`. Fix: the proxy config now
always carries `bypass: 'localhost,127.0.0.1,::1'`. Rebuilt, restarted,
re-tested: Quinn called `browse_page` once and got the rendered
headlines directly — no workaround. (This bug only bites when a proxy is
configured; the production server sets no proxy, so it would not have
shown up there — but the fix is in the code regardless.)

## Dev-VM limitation (diagnosed, not a tool bug)

The dev VM's egress proxy **refuses Chromium's CONNECT requests**
while allowing curl/Node's CONNECT to the same host (verified: raw
CONNECT from Node → 200; Chromium's CONNECT is well-formed — captured
against a local logging proxy — yet the egress proxy answers
`ERR_TUNNEL_CONNECTION_FAILED`, even with a normal Chrome user-agent
and even with a curl user-agent). This is the VM's egress enforcement,
not a Playwright/Chromium bug, and it cannot be fixed from the tool
side. Consequences for testing on the dev VM only: **no external page
can be browsed from here** — that is why the E2E used local test pages.
The production server has direct internet (no proxy), so external
browsing should work there; verify Zhihu hot after deploy.

## Known limits

- **X is unreachable from a China server** except through search
  results (network block, not a browser problem).
- **Douyin is hard to scrape reliably even with a browser** (JS-heavy,
  anti-bot, login walls).
- **Zhihu full answers need login/membership**: Zhihu 盐选专栏 answers
  show only an excerpt to anonymous visitors; the rest is paywalled.
  A browser does not change that — only a logged-in session (and
  membership) would, and Tree does not log in anywhere.
- **Captchas** cannot be passed by the browser; the tool reports them.
- **No persistent login/cookies**: fresh context per call, by design.
  A site that needs a login will report a login wall every time.
- **One browser launch per call** (~200 MB RAM each, a few seconds to
  start). Fine for occasional browsing; not for bulk scraping.
- The old `computer_*` / `open_browser` / `shell` tools still exist in
  `tools.ts` but point at Orgo, which is not configured; the prompt
  steers the bots away from them. Removing them is a later cleanup.
