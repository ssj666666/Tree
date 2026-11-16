# Tree Step 4.2 — remove Orgo leftovers (local computer)

Date: 2026-11-16. Status: **built and verified on the dev VM (no-key + fake-key
tests). NOT committed, NOT pushed, NOT deployed. Real-key end-to-end test still
to do on the server.**

## What was broken (user-reported, server already on step 4.1)

1. The right panel still showed `Bot's computer: Unreachable · Orgo GET
   /workspaces: Authentication required`, and Quinn told the user the Orgo key
   needed re-authorization. There is no Orgo key and none is needed — Orgo was
   deliberately removed in step 1.
2. Root cause: step 1 made `ORGO_API_KEY` optional but never removed (a) the
   periodic computer-status check (`server/src/computer.ts` → `orgo.workspaces()`)
   that wrote `status='error'` + that message into the `computers` DB row, and
   (b) the Orgo-backed screen tools in `server/src/agent/tools.ts`.

## What changed

### 1. The computer is local now — `server/src/computer.ts` (full rewrite)
- No Orgo import, no Orgo API call anywhere. The computer **is this Linux
  server**: it is awake exactly when the server answers requests, and it never
  sleeps.
- `computerState()` returns a derived healthy status: `{ status: 'running',
  orgoId: null, error: null, screens: [...] }`, where screens are derived from
  the bots in the database via `botScreen()` (`agent/browsertools.ts`):
  Quinn `:11`, Scout `:12`, Forge `:13`, Ledger `:14`, Brief `:15`, anything
  else `:19`.
- **Stale-row correction:** `rowFor()` fixes a leftover row on first read
  after the upgrade — if `orgo_id` is set, `status='error'`, or the error text
  mentions Orgo, the row is rewritten to `status='running', orgo_id=NULL,
  error=NULL`. No separate boot hook needed; every status read goes through it.
- `ensureComputer()` returns `'local'` (nothing to start);
  `suspendComputer()` is a no-op that logs that the local computer never
  sleeps; `refreshComputer()` returns the derived state (no network call);
  `screenFor()` returns `{ computerId: 'local', screenId: ':<display>' }`.
- The `computers` / `screens` DB tables are kept (other code reads them), but
  their contents are no longer authoritative. The `screens` table is now
  unread — screens are derived from bots.

### 2. Orgo client + VNC relay deleted
- **Deleted:** `server/src/orgo.ts` (the whole Orgo API client),
  `server/src/vnc.ts` (the noVNC relay to Orgo desktops),
  `web/src/components/ComputerViewer.tsx` (the fullscreen VNC viewer),
  `web/src/novnc.d.ts` (type declarations for the removed viewer).
- `server/src/index.ts`: `attachVncRelay` wiring removed.
- `server/src/env.ts`: `orgoKey`, `orgoWorkspaceId`, `orgoRamGb`, `orgoCpu`,
  `orgoResolution` removed. `.env.example`: ORGO lines removed.
- `server/src/idle.ts`: header comment updated — hibernation is now inert
  (its query selects `orgo_id IS NOT NULL`, which is empty after the
  migration, and `suspendComputer` is a no-op). Logic untouched.
- `deploy.sh`: `rm -rf server/dist web/dist` before `npm run build` — tsc
  never deletes outputs of removed sources, so without this the deleted
  files' stale build outputs (`server/dist/orgo.js`, `server/dist/vnc.js`)
  would linger on the server after deploy.

### 3. Orgo-backed screen tools removed — `server/src/agent/tools.ts`
- Removed: `computer_screenshot`, `computer_click`, `computer_type`,
  `computer_key`, `computer_scroll`, `computer_drag`, `open_browser`,
  `shell` (the Orgo-bash version). Removed helpers `shot()` / `onScreen()`.
- `computer_screenshot` is covered by the local `take_screenshot`,
  `open_browser` by `browse_page`, `shell` by `run_shell`. Click / type /
  key / scroll / drag have **no local equivalent yet** (no mouse/keyboard
  control on the virtual screens) — they are gone, not stubbed.
- `save_file` is back as a **local** implementation: writes to
  `<workspace>/files/<botId>/<name>` (5 MB cap, credential filenames
  refused), so the Library keeps working without Orgo.

### 4. Panel thumbnail + Library + screen reset go local
- `GET /api/bots/:id/screenshot` (`server/src/routes.ts`) now serves the
  bot's latest local screenshot (`data/screenshots/<bot>-latest.png`,
  written by `browse_page` / `take_screenshot`); 204 when there is none yet.
  The panel thumbnail now shows real local screenshots instead of failing.
- Library (`server/src/routes-config.ts`): `GET /bots/:id/files` lists the
  local `<workspace>/files/<botId>/` directory with `fs` (same response
  shape; `status` is always `ok`/`error` now, never `asleep`);
  `POST /bots/:id/files/download` returns a same-origin URL to a new
  `GET /bots/:id/files/raw` route that streams the file (50 MB cap, path
  traversal rejected). `LIB_ROOT` is now `path.join(env.workspace, 'files')`
  instead of the hardcoded `/root/tree/files`.
- `GET /computer/details`: screens are derived from bots (display + last
  screenshot mtime), not from the stale `screens` table.
- `POST /bots/:id/screen/reset`: kills the bot's local Chromium
  (`pkill -f user-data-dir=<profile>`) and removes `Singleton*` lock files;
  the Xvfb display itself persists. No screen deletion anymore.
- `parseLs` / `shq` / `boxFor` (Orgo helpers) deleted.

### 5. Bot knowledge — `server/src/agent/prompt.ts`
- New "电脑（Computer — 没有 Orgo）" section next to the voice section:
  Orgo is completely removed; there is no Orgo key and the user must never
  be asked to configure, buy, or re-authorize one; each bot's computer is
  this server + one virtual screen (Xvfb); if the UI still shows any
  Orgo-related error it is a leftover of the old check, it does not affect
  chatting, searching, files or voice, and no Orgo key should ever be
  suggested; there are no click/type/key screen-control tools.
- "How you work" line updated: the old "computer_*/open_browser/shell tools
  need a cloud computer" sentence replaced with the no-click/type/key note.
- `server/src/agent/localtools.ts` header comment fixed (no longer says
  "through a (not connected) Orgo cloud computer").

### 6. Frontend: the live VNC viewer is gone
- `DetailsPanel.tsx`: the "Bot's computer" card is now a plain status
  display (no click-to-open viewer). The thumbnail still polls the local
  screenshot endpoint every 4 s while running.
- `ChatView.tsx`: "Open computer" menu item removed. `App.tsx`: viewer
  render + import removed. `web/src/store.ts`: `viewerOpen` state removed.
- `AppSettings.tsx` Computer section: screen labels understand display
  strings (`:11` → "Display 11"); Wake/Sleep buttons removed (the computer
  is always awake — "Always awake" chip instead); hibernation text replaced
  with "This computer is the server itself — it stays awake around the clock
  and never sleeps."; Reset kept (closes the bot's browser windows).
- `LibraryTab.tsx`: header comment updated to the local path. The `asleep`
  branch can no longer trigger (kept as a harmless fallback).

## Verification (dev VM, 2026-11-16)

- `npm run typecheck` ✅ (server + web), `npm run build` ✅. Built
  `server/dist/agent/prompt.js` contains the "没有 Orgo" section (×2);
  `server/dist` contains **0** occurrences of `orgo.ai`; the removed tool
  names occur **0** times in `server/dist/agent/tools.js` (`save_file` still
  present); `web/dist` contains **0** occurrences of `ComputerViewer` /
  `novnc` / `/screen?mode=`.
- **No-key test** (throwaway copy in /tmp, port 8798, fake `DEEPSEEK_API_KEY`
  for boot only, no `DASHSCOPE_API_KEY`, no Orgo keys at all, real `.env` /
  `data/` untouched): `/api/health` ok; dev login ok; `GET /api/computer` →
  `{status:'running', orgoId:null, error:null, screens:[Quinn :11, Scout
  :12]}`; `GET /computer/details` → same derived screens; `GET
  /bots/:id/screenshot` → 204 (no screenshot yet); Library list/download/raw
  work on a locally seeded file, path traversal (`../..`) → 400; screen
  reset → `{ok:true, screenId:':11'}`; `POST /computer/ensure` and `POST
  /computer/suspend` both return `running`; `/api/voice/options` →
  `configured:false`.
- **Stale-row test:** seeded the exact production row into the test DB
  (`status='error'`, `orgo_id='orgo-123'`, `error='Orgo GET /workspaces:
  Authentication required'`, `updated_at` 2026-11-16 10:52 UTC). After one
  `GET /api/computer` the API returned `running`/`null`/`null` **and the DB
  row itself was corrected** (`orgo_id` null, `status` 'running', `error`
  null, fresh `updated_at`). This is the exact row on the production server.
- **Fake-key test** (`DASHSCOPE_API_KEY=sk-fake-...`): computer endpoints
  identical; `/api/voice/options` → `configured:true`, 8 voices; `/stt` →
  502 `stt_failed` "语音识别失败：HTTP 401" (request shape reaches
  DashScope, rejected only on auth — voice untouched by this step).
- Test servers stopped afterwards; `/tmp` test files deleted; real `.env`
  and `data/` untouched. **No real-key test was done (no keys available to
  this agent). No browser click-through was done (no browser session on the
  dev VM) — the frontend states are code-verified only.**

## How to test on the server (real key, after deploy)

Deploy is the normal flow: push this change, re-run deploy.sh (pinned
commit), `systemctl restart tree`, health check. No `.env` changes needed
(remove any `ORGO_*` lines from `/root/tree/.env` if present — they are
ignored now, but dead config is confusing).

1. Open Tree in the browser, log in. Right panel → "Bot's computer" should
   read **Awake** with **no red error text** and no "Wake computer" button.
   (If the panel still shows the Orgo error, hard-refresh — the fix is
   server-side, but a cached bundle could still show the old viewer.)
2. Settings → Computer: should say "Always awake" / "This computer is the
   server itself — it stays awake around the clock and never sleeps.";
   screens list Quinn Display 11, Scout Display 12.
3. Ask Quinn in chat: "Orgo 的 key 要重新授权吗？" or "为什么主 bot 显示你
   还没有启动" — it should say Orgo is gone, there is no key to authorize,
   and the computer is the local server. It must NOT ask for an Orgo key.
4. Ask Quinn to open a page (e.g. `https://www.zhihu.com/hot`) and take a
   screenshot — the panel thumbnail should show the page (local screenshot
   serving).
5. Ask Quinn to save a file (`save_file`) — it should appear in the Library
   tab, and download should work.
6. Voice still works as in 4.1 (Preview / push-to-talk / dictation) — this
   step did not touch the voice code.

## Known limits / open questions

- **No mouse/keyboard screen control:** `computer_click` / `computer_type` /
  `computer_key` / `computer_scroll` / `computer_drag` are removed with no
  local replacement. The bots can browse and screenshot their virtual
  screens, but cannot click or type into them yet. That needs a local input
  path (e.g. xdotool on the Xvfb display) — future work.
- **No live screen viewing:** the VNC viewer is deleted. Watching a bot's
  screen live is not possible in this step; the panel thumbnail (latest
  screenshot, refreshed every 4 s) is the only view. A future
  screenshot-based viewer could restore a watch-only view without Orgo.
- **`docs/orgo-builder-guide.md` still in the repo** (907 lines, 2026-11-09
  research doc on building Grokbot on Orgo). It makes no API calls, so it
  was left alone — but it now describes an architecture Tree no longer uses.
  Decide separately: delete it or keep it as history.
- **`ComputerState.orgoId` field still exists** (always `null` now) and the
  `computers` / `screens` DB tables are still created — kept so the API
  shape and old databases stay compatible. The `screens` table is no longer
  read anywhere.
- **Idle hibernation is inert** (see `idle.ts`): the watcher still runs, but
  its computer query matches nothing after the migration and suspend is a
  no-op. The `/computer/suspend` endpoint still exists and returns the
  running state. Removing the endpoint + watcher entirely is a later cleanup.
- **`ws` package is now unused** (only `vnc.ts` imported it). Left in
  `package.json` — removing a dependency needs a lockfile regen; harmless to
  keep for now.
- **PUSH NOTE (important):** the deletions are in the working tree but NOT
  in the git index yet (`orgo.ts`, `vnc.ts`, `ComputerViewer.tsx`,
  `novnc.d.ts` still show in `git ls-files`, 189 files). The API push
  helper enumerates `git ls-files`, so the parent MUST `git rm` those four
  files (and `git add STEP4.2-NOTES.md` + the modified files) before
  pushing, or the deleted files will be pushed back. Expected tracked count
  after cleanup: 189 − 4 + 1 (notes) = **186**.
