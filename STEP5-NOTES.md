# Tree Step 5 — Forge / Ledger / Brief: the full 5-bot team

Date: 2026-11-16 (night). Status: **built and verified on the dev VM with the
real DeepSeek key. NOT deployed yet — one deploy picks up step 4.2 + step 5
(+ email, step 6) together.**

## What was missing
The team rules (step 3.3) named five bots and the virtual screens (step 3.4)
were already reserved — Quinn :11, Scout :12, Forge :13, Ledger :14,
Brief :15 — but only Quinn and Scout existed as bots. Quinn's prompt listed
"Other Bots on the team" from the database, so it could only see Scout.

## What changed

### 1. One source of truth — `server/src/team.ts` (new)
- `TEAM_BOTS`: the five bot definitions (name, label, description,
  instructions, avatar, primary flag). Quinn and Scout are copied verbatim
  from the old seed code; Forge / Ledger / Brief are new.
  - **Forge（编程）** — hex/orange. Write/fix code, run tests, fix errors.
    Local commits OK; never touches .env/*.key/*.pem, never deploys, never
    pushes to GitHub.
  - **Ledger（整理）** — tablet/green. Summarise Skills, maintain the skills
    library, organise notes/files, weekly review. Never deletes user files,
    never changes team rules, never touches secrets.
  - **Brief（汇报）** — gem/violet. Daily brief, summaries, digests. Numbers
    must have a source; never invents a number.
- `createBot()` moved here unchanged from `routes.ts` (same INSERT, same
  avatar hash-pick).
- `ensureTeamBots(userId)` — creates whichever team bots are missing for a
  user, matched by name. Idempotent, and records a per-user flag
  `team_backfill_v1:<userId>` in a new `meta` table, so a bot the user
  deliberately deletes later is **not** resurrected on the next restart.

### 2. `server/src/db.ts`
- New `meta(key, value)` table (CREATE TABLE IF NOT EXISTS, in the schema
  block). Holds the backfill flag.

### 3. `server/src/routes.ts`
- `findOrCreateUser` now calls `ensureTeamBots(id)` instead of creating
  Quinn + Scout inline — a brand-new user gets all five bots at first login.
- Local `createBot` / `SHAPES` / `COLORS` / `hashPick` removed; imported
  from `team.ts`. (`Toolkit` type import kept — still used at line ~320.)

### 4. `server/src/index.ts`
- At startup, after `initRooms()`, runs `ensureTeamBots` for every existing
  user — this is what creates Forge/Ledger/Brief on the production server,
  whose admin user was created before step 5.

### 5. No changes needed elsewhere
- `prompt.ts` already lists each bot's own screen + profile and renders
  "Other Bots on the team" from the DB, so Quinn sees the three new bots
  automatically and can delegate with `send_to_bot`.
- `browsertools.ts` already maps Forge :13, Ledger :14, Brief :15 and
  per-bot browser profiles under `data/browser-profiles/<bot>/`.
- Voice: new bots inherit the `longyingtao_v3` default (step 4.1 fix).
- Rules R1–R10 already name the three bots and their red lines.

## Verification (real DeepSeek key, VM, 2026-11-16 night)
- `npm run typecheck -w server` ✓, `npm run build -w server` ✓.
- **New-user path:** fresh DB, dev login → `GET /api/bots` returns all five:
  Quinn (Chief of Staff), Scout (Search), Forge (Coding), Ledger
  (Organizing), Brief (Reporting).
- **Backfill path:** DB seeded with only Quinn + Scout (no flag) → server
  boot → `GET /api/bots` returns all five.
- **In-role replies (real key):**
  - Forge: wrote `/tmp/forge-hello.py`, ran it, reported Python 3.12.3,
    exit 0, and noted write_file only writes inside the workspace.
  - Ledger: gave a purpose-based classification for three notes.
  - Brief: one-sentence summary naming all five bots and their jobs.
- **Delegation loop:** Quinn was asked to have Forge write + run a hello
  world and summarise. Quinn delegated via `send_to_bot`, Forge wrote
  `/root/tree/hello.py`, ran it, reported back; Quinn re-ran it herself to
  verify and delivered the mandatory 4-part report (结果 / 做了什么 /
  没做成什么 / 花费 / 需要你做什么) per rule R10. Test artifacts removed
  after verification; both test servers (ports 8791/8792) stopped.

## Known limits (not bugs — next steps)
- The three new bots are **not** auto-added to the existing group chat
  （头脑风暴）: rooms store their own member list. Quinn can create a new
  5-bot room, or the user adds them from the UI. `send_to_bot` delegation
  works regardless of room membership.
- No routines were auto-created for the new bots. Brief taking over the
  08:00 daily digest, and Ledger owning the Sunday 21:00 weekly review,
  are routine assignments — ask Quinn when ready.
- The email tools (step 6) are shared by all bots; the inbox-manager role
  Dan Martell describes is Quinn's job for now, not a sixth bot.
