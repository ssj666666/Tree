# Tree Step 3.1 — "Local hands" (server/src/agent/localtools.ts)

Date: 2026-11-16. Status: built and verified on the dev machine. **Not yet deployed
to the Alibaba Cloud server and not yet pushed to GitHub** — code left
uncommitted for review; deploy with the normal flow (push → server pulls →
`bash deploy.sh`), after which the server's `.env` needs no new keys
(TREE_WORKSPACE defaults to /root/tree).

## What was built

The bots run on the server itself, so they can now act on it directly instead
of through the (never connected) Orgo cloud computer. Four new tools, all
registered in `server/src/agent/tools.ts` for every bot (Quinn + Scout):

- `run_shell` — run one bash command on the server, return stdout+stderr.
- `read_file` / `write_file` — read/write text files in the workspace.
- `fetch_page` — open a URL and return readable plain text.

New file: `server/src/agent/localtools.ts`. Small additions: `env.workspace`
(`TREE_WORKSPACE`, default `/root/tree`) in `server/src/env.ts`, a commented
`TREE_WORKSPACE` line in `.env.example`, and a rewritten "How you work" bullet
in `server/src/agent/prompt.ts` telling the bots to use the local tools (and
that the old `computer_*` / `open_browser` / `shell` tools need a cloud
computer that is not connected — do not use them). Auth, model/keys, and
existing tools (`web_search`, `remember`, …) are untouched.

## Safety rules (server runs as root — this matters)

- **Scope:** everything is confined to the workspace (`TREE_WORKSPACE`,
  default `/root/tree`). Paths are resolved (including symlinks) and rejected
  if they escape it. `run_shell`'s working directory must be inside the
  workspace or `/tmp`.
- **run_shell deny list** (refused with a clear message, never executed):
  - anything touching `.env` or naming a credential (`DEEPSEEK_API_KEY`,
    `BOCHA_API_KEY`, `COMPOSIO_API_KEY`, `ORGO_API_KEY`,
    `TREE_ADMIN_PASSWORD_HASH`, `SESSION_SECRET`);
  - wholesale environment dumps: bare `env` / `printenv` / `export` / `set`;
  - destructive commands: `mkfs`, `dd`, `shutdown`, `reboot`, `poweroff`,
    `halt`, `chmod 777 /`, and `rm -rf` on `/`, the workspace root, or any
    ancestor of it.
  - Note: the `.env` token is blocked wholesale, so even listing `.env`
    variable names (`grep -o '^[A-Za-z_]*=' .env`) is refused. Deliberate.
- **Scrubbed child environment:** the shell the agent gets does NOT contain
  any API key or the password hash, so `$DEEPSEEK_API_KEY` expansion finds
  nothing even if a check were bypassed.
- **Limits:** 60 s timeout (killed on timeout), output capped at ~6000 chars
  with a truncation notice; reads capped at ~20000 chars, writes at ~200000.
- **Logging:** every `run_shell` call and every `write_file` is appended to
  `data/tool-calls.log` (one JSON line: timestamp, command/path, exit code).
  `data/` is git-ignored.
- **Credential files:** `read_file`/`write_file` refuse `.env`, `*.key`,
  `*.pem`, and any `*password*` file.

## What was verified (dev server, port 8787, DEV_LOGIN=1, real DeepSeek key)

`npm run typecheck` ✅, `npm run build` ✅. Then a dev server with a fresh
DeepSeek surrogate, logged in as a test user, Quinn answering through the
real API:

- (a) `run_shell` — Quinn ran `pwd`, returned `/home/hatch/workspace/projects/tree` (the dev workspace), exit 0.
- (b) `write_file` + `read_file` — wrote `test-hands.md` ("Tree step 3 test"),
  read it back verbatim; file confirmed on disk.
- (c) `fetch_page` — Quinn searched (Bocha) for today's domestic tech news,
  then fetched a Tencent News article
  (`news.qq.com/rain/a/20261115A0CN1K00`) and summarised its real contents
  (AX100 chip, Huawei Cloud, Kirin 9050, HarmonyOS users, …).
- (d) Blocked command — `cat .env` via `run_shell` was refused with a clear
  message ("`.env` holds credentials…"), nothing leaked; the refusal is in
  `data/tool-calls.log` (`denied: true`).
- Extra unit checks against the built code: bare `env`, `rm -rf /`, and
  `echo $DEEPSEEK_API_KEY` all refused; `read_file`/`write_file` on `.env`
  refused; `/etc/passwd` refused as outside the workspace; fetching
  `douyin.com` returns only "Please wait..." (its anti-bot page — see limits).

Test server stopped afterwards; test data deleted (`data/`, `test-hands.md`,
cookies, logs) so the first real login stays fresh.

## Known limits

- **No headless browser:** `fetch_page` reads static HTML only — no
  JavaScript runs. JS-heavy pages (Douyin, some Zhihu/X pages) return little
  or no text; the tool says so instead of inventing content. A real browser
  (Playwright on the server, or a Wuying cloud desktop) is a later step.
- **No git push for the agent:** the agent may prepare local commits
  (`git add`/`git commit` inside the workspace), but pushing stays with the
  operator — GitHub reachability from mainland servers is untested/blocked
  (github.com failed from the ECS during deployment; only jsDelivr/ghproxy
  worked).
- **X is unreachable from a China server** except through search results;
  Douyin is hard to scrape reliably even with a browser.
- **WeChat has no open API** — unchanged: the agent cannot read group chats.
- The old `computer_*` / `open_browser` / `shell` / `save_file` tools still
  exist in `tools.ts` but point at Orgo, which is not configured; the prompt
  now steers the bots away from them. Removing them is a later cleanup.
- The deny list is string-based: a determined prompt-injection could still
  phrase a harmful command in a way it does not catch (e.g. `curl <url> |
  bash` is not blocked). The log file is the audit trail — review it.
