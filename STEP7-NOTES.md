# Tree Step 7 — Mouse on the virtual desktop (Computer Use)

Date: 2026-11-18. User asked: "怎么样才能让agent像一个人一样帮我操作鼠标？就像是agent在远程操控我的电脑一样". He chose the server virtual-desktop route first ("先给服务器虚拟桌面加鼠标"). The other route (a "hands" client on his own Windows PC) is still open for later.

## What was built

New file `server/src/agent/desktoptools.ts` — 7 tools, all scoped to the bot's OWN Xvfb display (1280x800; Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15).

X level (xdotool, works on any window on the display):
- `desktop_click(x, y)` — move mouse + left-click. Coordinates clamped to 0-1279 / 0-799; out-of-range is refused with the bounds.
- `desktop_type(text)` — type into the focused field (cap 2000 chars/call).
- `desktop_key(key)` — press a key. Allowlisted: Return/Tab/Escape/arrows/Home/End/Page_Up/Page_Down/F1-F12, plus ctrl/alt/shift + one letter/digit (e.g. ctrl+l).
- `desktop_screenshot()` — full 1280x800 desktop capture (ImageMagick `import -window root`) to `data/screenshots/<bot>-desktop.png`. Shows the mouse cursor and every window, unlike `take_screenshot` (browser page only).

Browser level (persistent headed Chromium kept open on the bot's display):
- `desktop_open(url)` — open a URL in the persistent desktop browser (one tab per bot, bot's persistent profile). Returns title + text snippet + screenshot path. Reuses the open browser; `page.goto` when already open.
- `desktop_click_text(text)` — click the element whose visible text matches (Playwright getByText). This is the vision-free click: the model is a text model and cannot look at a screenshot to find coordinates, so it clicks by the text it already read. Returns the page title + URL after the click.
- `desktop_close()` — close the persistent browser (frees ~300-400 MB). Prompt tells bots to close when done.

## Why two click paths (the vision problem)

DeepSeek is a text model: it cannot look at a screenshot and tell where a button is. Raw-coordinate clicks (`desktop_click`) are only reliable when the coordinates come from a non-visual source (the DOM, a known layout, or a point the user gives). `desktop_click_text` is the reliable path for web pages because it clicks by text the bot already read. A true vision-grounded click (screenshot → vision model → coordinates, e.g. Qwen-VL via Bailian) is a possible later step, not this one.

## Files changed

- `server/src/agent/desktoptools.ts` (new, 7 functions + helpers).
- `server/src/agent/browsertools.ts`: exported `displayReady` and `launchBotContext` (the persistent browser reuses them).
- `server/src/agent/tools.ts`: registered the 7 tools (desktop_open / desktop_click / desktop_click_text / desktop_type / desktop_key / desktop_screenshot / desktop_close).
- `server/src/agent/prompt.ts`: removed both "no mouse/keyboard tools" statements; added the desktop-tools description + rules (own display only; ask before clicking 确认/支付/提交 or typing into a password field).
- `deploy.sh`: new step 4e installs xdotool (EPEL) + ImageMagick (`import`) and verifies them; failures are warnings only (never kill the deploy).

## Server packages (installed 2026-11-18)

- xdotool 3.20200624.1 (`dnf install -y xdotool`, EPEL).
- ImageMagick 6.9.13 (`dnf install -y ImageMagick`) for `import`.
- Xvfb already running on :11-:15 (1280x800x24) since 09:08 today.

## Verification

VM (typecheck + build pass; smoke test with a fake Forge bot):
- All 7 functions fail gracefully without Xvfb/tools (no crash): "screen :13 not up", out-of-range refusal with bounds, bad-key refusal with the allowlist, "no desktop browser yet" for click_text/close.
- desktop_open + desktop_close lifecycle works headless on the VM (example.com failed with ERR_TUNNEL_CONNECTION_FAILED — VM proxy issue, not code; browser launched and closed cleanly).

Server (after deploy + restart) — acceptance test to run:
1. Forge opens a test page in its persistent desktop browser (a local HTML page with a button that changes text/colour on click).
2. desktop_screenshot (before) — verify the button is visible.
3. desktop_click on the button's coordinates (or desktop_click_text by its label).
4. desktop_screenshot (after) — verify the button changed.
5. Ask Forge via the API to use the tools (e.g. open a page and click by text) and confirm the result.

## Known limits

- No desktop environment / window manager on the virtual screens: the only GUI is the Chromium browser. The mouse can only interact with what is on the screen (the desktop browser, or any window the bot opens).
- No persistent-browser cleanup on server restart: the Map is in-memory; a restart drops the reference (the Chromium child is cleaned up with the Node process). Acceptable.
- `desktop_open` reuses the bot's persistent profile, same as browse_page. If browse_page runs at the same time with the same profile, Chromium may report the profile as locked; the error is returned plainly.
- Hover (mouse move without click) is not a separate tool yet; `desktop_click` moves then clicks. Add a `desktop_move` later if hover/menus need it.
- This step does NOT control the user's own Windows PC. That needs a separate "hands" client on his PC (via Tailscale) — bigger project, security review needed (full control of his computer; sensitive actions need approval).
