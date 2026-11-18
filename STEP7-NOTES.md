# Tree Step 7 — Mouse on the virtual desktop (Computer Use)

Date: 2026-11-18. User asked: "怎么样才能让agent像一个人一样帮我操作鼠标？就像是agent在远程操控我的电脑一样". He chose the server virtual-desktop route first ("先给服务器虚拟桌面加鼠标"). The other route (a "hands" client on his own Windows PC) is still open for later.

## What was built

New file `server/src/agent/desktoptools.ts` — 7 tools, all scoped to the bot's OWN Xvfb display (1280x800; Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15).

X level (xdotool, works on any window on the display):
- `desktop_screenshot()` — full 1280x800 desktop capture (ImageMagick `import -window root`) to `data/screenshots/<bot>-desktop.png`. Shows the mouse cursor and every window, unlike `take_screenshot` (browser page only).
- The real mouse cursor (xdotool) is moved to the matching screen spot on every `desktop_click`, so the user sees it move like a person's. xdotool is also the fallback for click/type/key when no desktop browser is open.

Browser level (persistent headed Chromium kept open on the bot's display):
- `desktop_open(url)` — open a URL in the persistent desktop browser (one tab per bot, bot's persistent profile). Returns title + text snippet + screenshot path. Reuses the open browser; `page.goto` when already open.
- `desktop_click_text(text)` — click the element whose visible text matches (Playwright getByText). This is the vision-free click: the model is a text model and cannot look at a screenshot to find coordinates, so it clicks by the text it already read. Returns the page title + URL after the click.
- `desktop_click(x, y)` — click at page (viewport) coordinates. When a desktop browser is open it uses Playwright's mouse (exact viewport coordinates, no offset math, focuses + clicks reliably) and also moves the xdotool cursor to the matching screen spot. When no browser is open it falls back to a raw xdotool screen click. Coordinates clamped to 0-1279 / 0-799; out-of-range is refused with the bounds.
- `desktop_type(text)` — type into the focused field (cap 2000 chars/call). When a desktop browser is open it uses Playwright's keyboard (handles any language including Chinese). xdotool `type` is the fallback; it depends on the X keymap and can silently drop characters it cannot map.
- `desktop_key(key)` — press a key (Playwright keyboard when a browser is open, xdotool otherwise). Allowlisted: Return/Tab/Escape/arrows/Home/End/Page_Up/Page_Down/F1-F12, plus ctrl/alt/shift + one letter/digit (e.g. ctrl+l).
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

## Verification (all passed, 2026-11-18)

VM (typecheck + build pass; smoke test with a fake Forge bot):
- All 7 functions fail gracefully without Xvfb/tools (no crash): "screen :13 not up", out-of-range refusal with bounds, bad-key refusal with the allowlist, "no desktop browser yet" for click_text/close.
- desktop_open + desktop_close lifecycle works headless on the VM (example.com failed with ERR_TUNNEL_CONNECTION_FAILED — VM proxy issue, not code; browser launched and closed cleanly).

Server (after deploy + restart) — acceptance test, Forge's display :13, test page http://127.0.0.1:8899/mouse-test.html (two buttons + one input):
- desktop_open: opened the page in Forge's persistent desktop browser.
- desktop_click_text("点我（按文字）"): button turned GREEN, text "文字点击成功 ✓".
- desktop_click(870, 400) by coordinates: button turned BLUE, text "坐标点击成功 ✓".
- desktop_click(640, 545) on the input + desktop_type("你好鼠标"): input shows "你好鼠标".
- desktop_screenshot (before/after) saved to data/screenshots/forge-desktop.png; verified by viewing the images.
- desktop_key Tab: pressed without error.
- Mouse location confirmed via `xdotool getmouselocation` (cursor tracks the clicks).

Agent-level test (Forge itself, via the API):
- Asked Forge to open the test page, click "点我（按文字）" by text, click the input, type "Forge来过", and screenshot. Forge did all of it (11 tool calls: desktop_open, desktop_click_text, desktop_click, desktop_type, desktop_screenshot, desktop_close, plus run_shell pixel checks) and verified the result itself by counting pixels in the screenshot (green #4CAF50 area = button clicked; 645 dark pixels inside the input = text present). Independent check of the screenshot confirms: green "文字点击成功 ✓", input "Forge来过", the other button untouched.

## Debugging notes (what went wrong along the way)

1. **Test page quoting bug.** The first test page was written via an SSH heredoc; the shell stripped the single quotes inside the inline `onclick="... '...' ..."` attributes, so the handler was invalid JS (`SyntaxError: Invalid or unexpected token`) and no click could fire it — even a JS `.click()` did nothing. Fix: rewrote the page with `addEventListener` in a `<script>` block, delivered via base64 (no shell quoting). Lesson: never write HTML/JS with quotes through a shell heredoc; use base64 or a file write.
2. **Coordinate offset.** The browser window sits at (10,10) and is 1288x931 on a 1280x800 screen, so page (viewport) coordinates are ~140px above the matching screen coordinates (tab bar + address bar). Raw xdotool clicks at viewport coordinates missed small targets (buttons are 100px tall so they tolerated it; the 56px input did not). Fix: desktop_click/type/key now prefer Playwright (page.mouse / page.keyboard) at exact viewport coordinates when a desktop browser is open, and desktop_click also moves the real xdotool cursor to the matching screen spot so the user sees it move. xdotool remains the fallback when no browser is open. xdotool `type` also silently drops characters the X keymap cannot map (a CJK risk), which is why Playwright keyboard is preferred for typing.
3. **Window taller than the screen.** The browser window (931px) is taller than the 1280x800 X display, so the bottom ~140px of the page viewport is off-screen and not clickable by the real mouse. Playwright clicks still work there (they are synthetic), but the visible cursor cannot reach them. Known limitation; the agent should scroll or click higher up. A future fix is to launch the desktop browser with a smaller viewport (e.g. 1280x650) so the whole window fits.

## Known limits

- No desktop environment / window manager on the virtual screens: the only GUI is the Chromium browser. The mouse can only interact with what is on the screen (the desktop browser, or any window the bot opens).
- No persistent-browser cleanup on server restart: the Map is in-memory; a restart drops the reference (the Chromium child is cleaned up with the Node process). Acceptable.
- `desktop_open` reuses the bot's persistent profile, same as browse_page. If browse_page runs at the same time with the same profile, Chromium may report the profile as locked; the error is returned plainly.
- Hover (mouse move without click) is not a separate tool yet; `desktop_click` moves then clicks. Add a `desktop_move` later if hover/menus need it.
- This step does NOT control the user's own Windows PC. That needs a separate "hands" client on his PC (via Tailscale) — bigger project, security review needed (full control of his computer; sensitive actions need approval).
