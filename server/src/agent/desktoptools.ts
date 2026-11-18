import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { env } from '../env.js';
import { botScreen, displayReady, launchBotContext } from './browsertools.js';
import { logCall } from './localtools.js';

/**
 * Tree step 7 — "mouse hands": operate the bot's own virtual desktop
 * like a person would (Computer Use).
 *
 * Each bot has its OWN Xvfb virtual screen (Quinn :11, Scout :12,
 * Forge :13, Ledger :14, Brief :15), 1280x800. Before this step the
 * screens were view-only (browse_page / take_screenshot). Now the bot
 * can also drive its own screen:
 *
 *   X level (xdotool, works on any window on the display):
 *   - desktop_click(x, y): move the mouse and left-click.
 *   - desktop_type(text): type text into whatever has keyboard focus.
 *   - desktop_key(key): press a key (Return, Tab, Escape, ctrl+l...).
 *   - desktop_screenshot: capture the whole 1280x800 desktop
 *     (ImageMagick `import -window root`) to
 *     data/screenshots/<bot>-desktop.png — this shows the mouse cursor
 *     and every window, unlike take_screenshot (browser page only).
 *
 *   Browser level (a persistent headed Chromium kept open on the
 *   bot's display, so there is something for the mouse to click):
 *   - desktop_open(url): open a URL in the persistent desktop browser
 *     (kept open until desktop_close; one tab per bot).
 *   - desktop_click_text(text): click the element whose visible text
 *     matches, in the persistent browser. This is the vision-free way
 *     to click: the bot reads the page as text (desktop_open returns
 *     it) and clicks by text instead of guessing coordinates.
 *   - desktop_close: close the persistent desktop browser (frees the
 *     ~300-400 MB Chromium; always close when done).
 *
 * Why two click paths: the model is a text model — it cannot look at
 * a screenshot and tell where a button is. desktop_click_text lets it
 * click by the text it already read. desktop_click(x, y) is the raw
 * mouse for canvas/maps/known layouts, and for anything the user
 * points at by coordinates.
 *
 * Safety:
 * - Everything is scoped to the bot's OWN display (botScreen). A bot
 *   can never touch another bot's screen.
 * - Coordinates are clamped to the 1280x800 screen; out-of-range
 *   clicks are refused with a clear message.
 * - Keys are allowlisted (named keys + ctrl/alt/shift combos only).
 * - Text is capped (2000 chars per call).
 * - Never throws: a missing tool (xdotool/import not installed), a
 *   display that is not up, or a failed click returns a short Chinese
 *   notice, so the conversation never crashes.
 * - Every call is logged to data/tool-calls.log.
 *
 * Server requirements (installed by deploy.sh step 4c):
 * xdotool (EPEL) for the mouse/keyboard, ImageMagick (`import`) for
 * the desktop screenshot. If either is missing, the affected tools
 * say so plainly instead of failing.
 */

const SCREEN_W = 1280;
const SCREEN_H = 800;
const MAX_TYPE_CHARS = 2000;
const CLICK_TIMEOUT_MS = 5000;
const GOTO_TIMEOUT_MS = 30_000;

const WORKSPACE = path.resolve(env.workspace);
const SCREENSHOTS_DIR = path.join(WORKSPACE, 'data', 'screenshots');

/** One persistent desktop browser per bot (in-memory only). */
const desktopBrowsers = new Map<string, { context: BrowserContext; page: Page | null }>();

/** Named keys xdotool accepts (plus ctrl/alt/shift + one of these / a letter). */
const NAMED_KEYS = new Set([
  'Return', 'Tab', 'Escape', 'space', 'BackSpace', 'Delete',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Page_Up', 'Page_Down',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function validKey(raw: string): string | null {
  const k = String(raw ?? '').trim();
  if (!k) return null;
  // Single named key, or ctrl/alt/shift + (named key or one letter/digit).
  const m = k.match(/^(?:(ctrl|alt|shift)\+)?([A-Za-z0-9]+)$/);
  if (!m) return null;
  const mod = m[1];
  const base = m[2];
  if (!mod) return NAMED_KEYS.has(base) || /^[a-z]$/.test(base) ? base : null;
  if (NAMED_KEYS.has(base)) return `${mod}+${base}`;
  if (/^[a-z0-9]$/.test(base)) return `${mod}+${base}`;
  return null;
}

/** Run a binary (no shell) with DISPLAY set to the bot's screen. */
function runOnDisplay(display: number, cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, DISPLAY: `:${display}` }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Is this binary installed? (cached; a missing tool is reported, not fatal). */
const toolCache = new Map<string, boolean>();
async function toolAvailable(name: string): Promise<boolean> {
  if (toolCache.has(name)) return toolCache.get(name)!;
  // Version probe (no shell needed): xdotool --version / import -version.
  const probe = name === 'xdotool' ? ['--version'] : ['-version'];
  const p = await runOnDisplay(0, name, probe, 5_000).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const ok = p.code === 0;
  toolCache.set(name, ok);
  return ok;
}

function screenOf(bot: { id: string; name: string }) {
  return botScreen(bot);
}

/** Desktop screenshot path for this bot. */
function desktopShotPath(slug: string): string {
  return path.join(SCREENSHOTS_DIR, `${slug}-desktop.png`);
}

// ---------- X level: mouse / keyboard / full-desktop screenshot ----------

export async function desktopScreenshot(bot: { id: string; name: string }): Promise<string> {
  const screen = screenOf(bot);
  if (!displayReady(screen.display)) {
    return `你的虚拟屏幕 :${screen.display} 未启动，截不到图。请告诉用户（服务器上重跑 deploy.sh 里的 Xvfb 启动步骤）。`;
  }
  if (!(await toolAvailable('import'))) {
    return '截取整个桌面需要 ImageMagick 的 import 工具，但服务器上还没装（deploy.sh 里的 4c 步会装）。请告诉用户。';
  }
  const out = desktopShotPath(screen.slug);
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const r = await runOnDisplay(screen.display, 'import', ['-window', 'root', out]);
    if (r.code !== 0 || !fs.existsSync(out)) {
      logCall({ tool: 'desktop_screenshot', bot: screen.slug, display: screen.display, ok: false, error: (r.stderr || r.stdout).split('\n')[0] });
      return `截取桌面失败：${(r.stderr || r.stdout).split('\n')[0] || 'import 退出码 ' + r.code}。`;
    }
    logCall({ tool: 'desktop_screenshot', bot: screen.slug, display: screen.display, ok: true, screenshot: out });
    return `桌面截图已保存：data/screenshots/${screen.slug}-desktop.png（你的屏幕 :${screen.display}，1280x800，包含鼠标指针和所有窗口）。`;
  } catch (e: any) {
    return `截取桌面时出错：${String(e?.message ?? e).split('\n')[0]}`;
  }
}

export async function desktopClick(bot: { id: string; name: string }, x: number, y: number): Promise<string> {
  const screen = screenOf(bot);
  const cx = Math.floor(Number(x));
  const cy = Math.floor(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return '坐标必须是数字，例如 (640, 400)。';
  if (cx < 0 || cx >= SCREEN_W || cy < 0 || cy >= SCREEN_H) {
    return `坐标 (${cx}, ${cy}) 超出了 1280x800 的范围（x 是 0-${SCREEN_W - 1}，y 是 0-${SCREEN_H - 1}）。`;
  }
  if (!displayReady(screen.display)) return `你的虚拟屏幕 :${screen.display} 未启动，点不了。请告诉用户。`;
  // Prefer the desktop browser: Playwright's mouse clicks at exact page
  // (viewport) coordinates — no offset math, and it focuses + clicks
  // reliably. The real mouse cursor is moved to the matching screen spot
  // as well, so the user sees it move like a person's.
  const page = openDesktopPage(bot);
  if (page) {
    try {
      await page.mouse.click(cx, cy);
    } catch (e: any) {
      logCall({ tool: 'desktop_click', bot: screen.slug, display: screen.display, x: cx, y: cy, ok: false, error: String(e?.message ?? e).split('\n')[0] });
      return `点击 (${cx}, ${cy}) 失败：${String(e?.message ?? e).split('\n')[0]}。`;
    }
    const off = await viewportOffset(bot);
    if (off && (await toolAvailable('xdotool'))) {
      const sx = cx + off.dx;
      const sy = cy + off.dy;
      if (sx >= 0 && sx < SCREEN_W && sy >= 0 && sy < SCREEN_H) {
        await runOnDisplay(screen.display, 'xdotool', ['mousemove', String(sx), String(sy)]).catch(() => {});
      }
    }
    logCall({ tool: 'desktop_click', bot: screen.slug, display: screen.display, x: cx, y: cy, ok: true, via: 'playwright' });
    return `已在你的屏幕 :${screen.display} 上点击 (${cx}, ${cy})。想确认点中了什么，用 desktop_screenshot 看一眼。`;
  }
  // No desktop browser: raw screen click with the real mouse (xdotool).
  if (!(await toolAvailable('xdotool'))) return '鼠标工具 xdotool 还没装在服务器上（deploy.sh 里的 4c 步会装）。请告诉用户。';
  const r = await runOnDisplay(screen.display, 'xdotool', ['mousemove', String(cx), String(cy), 'click', '1']);
  if (r.code !== 0) {
    logCall({ tool: 'desktop_click', bot: screen.slug, display: screen.display, x: cx, y: cy, ok: false, error: (r.stderr || r.stdout).split('\n')[0] });
    return `点击 (${cx}, ${cy}) 失败：${(r.stderr || r.stdout).split('\n')[0] || 'xdotool 退出码 ' + r.code}。`;
  }
  logCall({ tool: 'desktop_click', bot: screen.slug, display: screen.display, x: cx, y: cy, ok: true, via: 'xdotool' });
  return `已在你的屏幕 :${screen.display} 上点击 (${cx}, ${cy})。想确认点中了什么，用 desktop_screenshot 看一眼。`;
}

/** The open desktop browser's page, or null when there is none. */
function openDesktopPage(bot: { id: string; name: string }): Page | null {
  const screen = screenOf(bot);
  const entry = desktopBrowsers.get(screen.slug);
  if (!entry || !entry.page || entry.page.isClosed()) return null;
  return entry.page;
}

/** Map our key names to Playwright keyboard names. */
function toPlaywrightKey(k: string): string {
  const named: Record<string, string> = {
    Return: 'Enter', Tab: 'Tab', Escape: 'Escape', space: 'Space',
    BackSpace: 'Backspace', Delete: 'Delete',
    Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
    Home: 'Home', End: 'End', Page_Up: 'PageUp', Page_Down: 'PageDown',
  };
  const m = k.match(/^(ctrl|alt|shift)\+(.+)$/);
  if (m) {
    const mod = m[1] === 'ctrl' ? 'Control' : m[1] === 'alt' ? 'Alt' : 'Shift';
    const base = named[m[2]] ?? m[2];
    return `${mod}+${base}`;
  }
  if (/^F\d+$/.test(k)) return k;
  return named[k] ?? k;
}

/** Measure the page-viewport-to-screen offset from the open desktop browser. */
async function viewportOffset(bot: { id: string; name: string }): Promise<{ dx: number; dy: number } | null> {
  const screen = screenOf(bot);
  const entry = desktopBrowsers.get(screen.slug);
  if (!entry || !entry.page || entry.page.isClosed()) return null;
  try {
    const m = await entry.page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    }));
    return {
      dx: Math.round(m.screenX + (m.outerW - m.innerW) / 2),
      dy: Math.round(m.screenY + (m.outerH - m.innerH)),
    };
  } catch {
    return null;
  }
}

export async function desktopType(bot: { id: string; name: string }, text: string): Promise<string> {
  const screen = screenOf(bot);
  const t = String(text ?? '');
  if (!t) return '没有给要输入的文字。';
  if (t.length > MAX_TYPE_CHARS) return `要输入的文字太长（${t.length} 字，单次上限 ${MAX_TYPE_CHARS} 字）。分几次输入。`;
  if (!displayReady(screen.display)) return `你的虚拟屏幕 :${screen.display} 未启动，输不了字。请告诉用户。`;
  // Prefer the desktop browser: Playwright's keyboard types any language
  // (including Chinese) into the focused field, reliably. xdotool's
  // `type` depends on the X keymap and silently drops characters it
  // cannot map, so it is only the fallback when no browser is open.
  const page = openDesktopPage(bot);
  if (page) {
    try {
      await page.keyboard.type(t);
    } catch (e: any) {
      logCall({ tool: 'desktop_type', bot: screen.slug, display: screen.display, chars: t.length, ok: false, error: String(e?.message ?? e).split('\n')[0] });
      return `输入文字失败：${String(e?.message ?? e).split('\n')[0]}。`;
    }
    logCall({ tool: 'desktop_type', bot: screen.slug, display: screen.display, chars: t.length, ok: true, via: 'playwright' });
    return `已在你的屏幕 :${screen.display} 上输入 ${t.length} 个字符（打进了当前获得焦点的输入框）。`;
  }
  // No desktop browser: type with the real keyboard (xdotool).
  if (!(await toolAvailable('xdotool'))) return '键盘工具 xdotool 还没装在服务器上（deploy.sh 里的 4c 步会装）。请告诉用户。';
  const r = await runOnDisplay(screen.display, 'xdotool', ['type', '--', t]);
  if (r.code !== 0) {
    logCall({ tool: 'desktop_type', bot: screen.slug, display: screen.display, chars: t.length, ok: false, error: (r.stderr || r.stdout).split('\n')[0] });
    return `输入文字失败：${(r.stderr || r.stdout).split('\n')[0] || 'xdotool 退出码 ' + r.code}。`;
  }
  logCall({ tool: 'desktop_type', bot: screen.slug, display: screen.display, chars: t.length, ok: true, via: 'xdotool' });
  return `已在你的屏幕 :${screen.display} 上输入 ${t.length} 个字符（打进了当前获得焦点的输入框）。`;
}

export async function desktopKey(bot: { id: string; name: string }, key: string): Promise<string> {
  const screen = screenOf(bot);
  const k = validKey(key);
  if (!k) return `按键 "${String(key ?? '')}" 不支持。能用的按键：Return、Tab、Escape、方向键、Home/End、Page_Up/Page_Down、F1-F12，以及 ctrl/alt/shift + 单个字母或数字（例如 ctrl+l、ctrl+c、alt+Tab）。`;
  if (!displayReady(screen.display)) return `你的虚拟屏幕 :${screen.display} 未启动，按不了键。请告诉用户。`;
  // Prefer the desktop browser (Playwright keyboard); xdotool is the
  // fallback when no browser is open.
  const page = openDesktopPage(bot);
  if (page) {
    try {
      await page.keyboard.press(toPlaywrightKey(k));
    } catch (e: any) {
      logCall({ tool: 'desktop_key', bot: screen.slug, display: screen.display, key: k, ok: false, error: String(e?.message ?? e).split('\n')[0] });
      return `按键 ${k} 失败：${String(e?.message ?? e).split('\n')[0]}。`;
    }
    logCall({ tool: 'desktop_key', bot: screen.slug, display: screen.display, key: k, ok: true, via: 'playwright' });
    return `已在你的屏幕 :${screen.display} 上按下 ${k}。`;
  }
  if (!(await toolAvailable('xdotool'))) return '键盘工具 xdotool 还没装在服务器上（deploy.sh 里的 4c 步会装）。请告诉用户。';
  const r = await runOnDisplay(screen.display, 'xdotool', ['key', k]);
  if (r.code !== 0) {
    logCall({ tool: 'desktop_key', bot: screen.slug, display: screen.display, key: k, ok: false, error: (r.stderr || r.stdout).split('\n')[0] });
    return `按键 ${k} 失败：${(r.stderr || r.stdout).split('\n')[0] || 'xdotool 退出码 ' + r.code}。`;
  }
  logCall({ tool: 'desktop_key', bot: screen.slug, display: screen.display, key: k, ok: true, via: 'xdotool' });
  return `已在你的屏幕 :${screen.display} 上按下 ${k}。`;
}

// ---------- Browser level: persistent desktop browser ----------

function validateUrl(raw: string): { ok: true; url: string } | { ok: false; notice: string } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, notice: '没有给网址。' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, notice: `网址无效：${trimmed}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, notice: '只支持 http(s) 网址。' };
  return { ok: true, url: u.toString() };
}

/**
 * Open a URL in this bot's persistent desktop browser (one tab, kept
 * open on the bot's own screen until desktop_close). Reuses the open
 * browser when there is one; otherwise launches a headed Chromium with
 * the bot's persistent profile.
 */
export async function desktopOpen(bot: { id: string; name: string }, url: string): Promise<string> {
  const screen = screenOf(bot);
  const checked = validateUrl(url);
  if (!checked.ok) return checked.notice;
  const raw = checked.url;

  let entry = desktopBrowsers.get(screen.slug);
  let headed = displayReady(screen.display);
  try {
    if (!entry) {
      const launched = await launchBotContext(screen);
      headed = launched.headed;
      entry = { context: launched.context, page: null };
      desktopBrowsers.set(screen.slug, entry);
    }
    let page = entry.page;
    if (!page || page.isClosed()) {
      page = await entry.context.newPage();
      entry.page = page;
    }
    try {
      await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (e: any) {
      const msg = String(e?.message ?? e).split('\n')[0];
      logCall({ tool: 'desktop_open', bot: screen.slug, url: raw, ok: false, error: msg, headed, display: screen.display });
      return `打开 ${raw} 失败：${msg}。浏览器还开着，换个网址再试。`;
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // Continue with what rendered.
    }
    await page.waitForTimeout(1000).catch(() => {});
    const title = (await page.title().catch(() => '')) || '(无标题)';
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const clean = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
    let shot = false;
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      await page.screenshot({ path: screen.screenshotPath });
      shot = true;
    } catch {
      shot = false;
    }
    logCall({ tool: 'desktop_open', bot: screen.slug, url: raw, ok: true, title: title.slice(0, 120), headed, display: screen.display, screenshot: shot ? screen.screenshotPath : null });
    const mode = headed ? `已在你的屏幕 :${screen.display} 上打开（浏览器保持开着，鼠标可以直接点）` : `已打开（注：你的虚拟屏幕 :${screen.display} 未启动，本次用无头模式打开）`;
    return `${mode}\n标题：${title}\n网址：${raw}\n\n${clean || '(页面上没有可读文字。)'}${shot ? `\n\n截图：data/screenshots/${screen.slug}-latest.png` : ''}`;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split('\n')[0];
    logCall({ tool: 'desktop_open', bot: screen.slug, url: raw, ok: false, error: msg, headed, display: screen.display });
    // A failed launch leaves a broken entry behind; drop it so the next
    // call starts clean instead of reusing a dead browser.
    if (entry) {
      await entry.context.close().catch(() => {});
      desktopBrowsers.delete(screen.slug);
    }
    return `打开桌面浏览器失败：${msg}。可能是浏览器还没装好（服务器上重跑 deploy.sh 里的 4c 步），请告诉用户。`;
  }
}

/**
 * Click the element whose visible text matches, in the persistent
 * desktop browser. No coordinates needed — this is how a text model
 * clicks reliably. The page title + URL after the click are returned
 * so the caller can see what happened (e.g. navigation).
 */
export async function desktopClickText(bot: { id: string; name: string }, text: string): Promise<string> {
  const screen = screenOf(bot);
  const t = String(text ?? '').trim();
  if (!t) return '没有给要点的文字。';
  const entry = desktopBrowsers.get(screen.slug);
  if (!entry || !entry.page || entry.page.isClosed()) {
    return '桌面浏览器还没打开。先用 desktop_open 打开一个页面，再按文字点。';
  }
  const page = entry.page;
  try {
    await page.getByText(t, { exact: false }).first().click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    logCall({ tool: 'desktop_click_text', bot: screen.slug, text: t.slice(0, 80), ok: false, error: 'not found' });
    return `在当前页面上没找到包含「${t}」的可点元素。可能是文字不在页面上，或者它不是能点的元素。换个词再试，或用 desktop_screenshot 看一眼页面。`;
  }
  await page.waitForTimeout(1000).catch(() => {});
  const title = (await page.title().catch(() => '')) || '(无标题)';
  const url = page.url();
  try {
    await page.screenshot({ path: screen.screenshotPath });
  } catch {
    // Screenshot is best-effort; the click already happened.
  }
  logCall({ tool: 'desktop_click_text', bot: screen.slug, text: t.slice(0, 80), ok: true, title: title.slice(0, 120), url });
  return `已点击包含「${t}」的元素。\n当前页面：${title}\n网址：${url}\n截图：data/screenshots/${screen.slug}-latest.png`;
}

/** Close this bot's persistent desktop browser (frees ~300-400 MB). */
export async function desktopClose(bot: { id: string; name: string }): Promise<string> {
  const screen = screenOf(bot);
  const entry = desktopBrowsers.get(screen.slug);
  if (!entry) return '桌面浏览器本来就没开着。';
  try {
    await entry.context.close();
  } catch {
    // Already closed; just drop the entry.
  }
  desktopBrowsers.delete(screen.slug);
  logCall({ tool: 'desktop_close', bot: screen.slug, display: screen.display, ok: true });
  return `已关闭你的屏幕 :${screen.display} 上的桌面浏览器。`;
}
