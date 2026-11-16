import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { logCall } from './localtools.js';

/**
 * Tree step 3.2 — "browser hands": a real browser.
 * Tree step 3.4 — one virtual screen per bot (bot-hq model).
 *
 * browse_page opens the URL in a real Chromium that runs JavaScript and
 * returns the rendered text. Since step 3.4 each bot has its OWN virtual
 * screen (Xvfb display) and its OWN persistent browser profile:
 *
 *   Quinn :11 · Scout :12 · Forge :13 · Ledger :14 · Brief :15
 *   (base display from TREE_XVFB_BASE_DISPLAY, default 11)
 *   profiles: data/browser-profiles/<bot>/  (git-ignored; logins/cookies
 *   persist per bot across restarts — that persistence is the point)
 *   screenshots: data/screenshots/<bot>-latest.png
 *
 * Behaviour:
 * - Headed Chromium on the bot's display when Xvfb is up; if the display
 *   is not running, it falls back to headless mode and says so in the
 *   result (graceful degradation, never a crash).
 * - Browsers launch ON DEMAND per call and close afterwards — NOT 24/7.
 *   Only the Xvfb displays run persistently (cheap: ~20-30 MB each).
 *   A headed Chromium is ~300-400 MB while it runs.
 * - Every browse saves a screenshot of the page; take_screenshot re-opens
 *   the bot's last page and screenshots it again.
 * - Never throws: unreachable/blocked/captcha/login-wall pages return a
 *   short Chinese notice, so the conversation never crashes.
 * - Runs as root, so Chromium gets --no-sandbox (the same reason headless
 *   CI containers use it).
 * - A proxy is used only if the standard HTTPS_PROXY/HTTP_PROXY env vars
 *   are set (the production server has direct internet and sets none).
 *   Loopback addresses (localhost,127.0.0.1,::1) always bypass the proxy.
 * - TREE_CHROMIUM_PATH may point at a system Chromium instead of
 *   Playwright's bundled one (fallback if the bundled build cannot run).
 * - Every call is logged to data/tool-calls.log (URL + outcome only).
 *
 * glibc note (verified 2026-11-16, see STEP3.2-NOTES.md): Playwright
 * 1.65.1's bundled Chromium 159 needs at most GLIBC_2.25, and the
 * production server has glibc 2.32, so the bundled build should run
 * there.
 *
 * Out of scope for this step (future work): user takeover — the user
 * driving a bot's screen with their own mouse/keyboard. The screens are
 * virtual (Xvfb); there is no VNC/RDP attached yet.
 */

const MAX_TEXT_CHARS = 8000;
const MAX_LINKS = 10;

const WORKSPACE = path.resolve(env.workspace);
const PROFILES_DIR = path.join(WORKSPACE, 'data', 'browser-profiles');
const SCREENSHOTS_DIR = path.join(WORKSPACE, 'data', 'screenshots');

/** Overall budget for one browse_page call (env TREE_BROWSE_TIMEOUT_MS, default 60s). */
const GOTO_TIMEOUT_MS = Math.min(30_000, Math.max(5_000, Math.floor(env.browseTimeoutMs * 0.5)));
const IDLE_TIMEOUT_MS = Math.min(15_000, Math.max(3_000, Math.floor(env.browseTimeoutMs * 0.25)));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Display-number offset per bot, from the base display (default 11). */
const DISPLAY_OFFSETS: Record<string, number> = { quinn: 0, scout: 1, forge: 2, ledger: 3, brief: 4 };
/** Unknown bots share this fallback display (base + 8 = :19 by default). */
const FALLBACK_OFFSET = 8;

export interface BotScreen {
  /** Filesystem-safe bot name, e.g. "quinn". */
  slug: string;
  /** X display number, e.g. 11 for Quinn. */
  display: number;
  /** Persistent Chromium profile directory for this bot. */
  profileDir: string;
  /** Path of this bot's latest screenshot. */
  screenshotPath: string;
}

function botSlug(name: string): string {
  const s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'bot';
}

export function botScreen(bot: { id: string; name: string }): BotScreen {
  const slug = botSlug(bot.name);
  const offset = DISPLAY_OFFSETS[slug] ?? FALLBACK_OFFSET;
  const display = env.xvfbBaseDisplay + offset;
  return {
    slug,
    display,
    profileDir: path.join(PROFILES_DIR, slug),
    screenshotPath: path.join(SCREENSHOTS_DIR, `${slug}-latest.png`),
  };
}

/** Is an X server listening on this display? (Xvfb creates /tmp/.X11-unix/X<n>.) */
function displayReady(display: number): boolean {
  try {
    return fs.existsSync(`/tmp/.X11-unix/X${display}`);
  } catch {
    return false;
  }
}

/**
 * Proxy from the standard env vars, if any (credentials stay in memory only).
 * Loopback addresses always bypass the proxy: without this, Chromium sends
 * even http://127.0.0.1 through the proxy and the request dies there
 * (seen 2026-11-16: ERR_EMPTY_RESPONSE on localhost pages).
 */
function proxyFromEnv(): { server: string; bypass: string; username?: string; password?: string } | undefined {
  const raw = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '').trim();
  if (!raw) return undefined;
  const bypass = 'localhost,127.0.0.1,::1';
  const m = raw.match(/^(https?:\/\/)([^:/?#]+):([^@/?#]+)@(.+)$/);
  if (m) return { server: `${m[1]}${m[4]}`, bypass, username: decodeURIComponent(m[2]), password: decodeURIComponent(m[3]) };
  if (/^https?:\/\//.test(raw)) return { server: raw, bypass };
  return { server: `http://${raw}`, bypass };
}

/**
 * Launch Chromium on this bot's own screen with its own persistent
 * profile. Headed when the bot's Xvfb display is up, headless otherwise.
 * The caller MUST close the returned context (it closes the browser too).
 */
async function launchBotContext(screen: BotScreen): Promise<{ context: BrowserContext; headed: boolean }> {
  const proxy = proxyFromEnv();
  const headed = displayReady(screen.display);
  const context = await chromium.launchPersistentContext(screen.profileDir, {
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--user-agent=${BROWSER_UA}`],
    ...(env.chromiumPath ? { executablePath: env.chromiumPath } : {}),
    ...(proxy ? { proxy } : {}),
    ...(headed ? { env: { ...process.env, DISPLAY: `:${screen.display}` } } : {}),
    viewport: { width: 1280, height: 800 },
  });
  return { context, headed };
}

/** Last page each bot opened (in-memory only; the profile on disk is what persists). */
const lastPageBySlug = new Map<string, { url: string; title: string; at: string }>();

const CAPTCHA_RE = /captcha|人机验证|请验证|滑动验证|请完成验证|verify you are (not )?human|are you a robot/i;
const LOGIN_WALL_RE = /请登录|登录后查看|登录后才能|sign in to continue|log in to (view|continue)/i;

/** Rendered text + a few key links from the loaded page. */
async function extractPage(page: Page): Promise<{ title: string; text: string; links: { text: string; href: string }[] }> {
  const title = (await page.title().catch(() => '')) || '';
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const links = await page
    .$$eval('a[href]', (anchors) => {
      const out: { text: string; href: string }[] = [];
      const seen = new Set<string>();
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const t = (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!href.startsWith('http') || !t || seen.has(href)) continue;
        seen.add(href);
        out.push({ text: t, href });
        if (out.length >= 10) break;
      }
      return out;
    })
    .catch(() => []);
  return { title, text, links };
}

/** Best-effort screenshot of the current page (never throws). */
async function saveShot(page: Page, screen: BotScreen): Promise<boolean> {
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({ path: screen.screenshotPath });
    return true;
  } catch {
    return false;
  }
}

function validateUrl(raw: string): { ok: true; url: URL } | { ok: false; notice: string } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, notice: '没有给网址。' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, notice: `网址无效：${trimmed}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, notice: '只支持 http(s) 网址。' };
  }
  return { ok: true, url: u };
}

export async function browsePage(url: string, bot: { id: string; name: string }): Promise<string> {
  const screen = botScreen(bot);
  const checked = validateUrl(url);
  if (!checked.ok) return checked.notice;
  const raw = String(url).trim();
  const u = checked.url;

  const started = Date.now();
  let ctx: BrowserContext | null = null;
  let headed = false;
  try {
    try {
      ({ context: ctx, headed } = await launchBotContext(screen));
    } catch (e: any) {
      logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: false, error: `launch failed: ${e?.message ?? e}` });
      return `浏览器启动失败：${e?.message ?? e}。可能是浏览器还没装好（服务器上重跑 deploy.sh 里的 4c 步），请告诉用户。`;
    }

    const page = await ctx.newPage();
    let response: import('playwright').Response | null = null;
    try {
      response = await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (e: any) {
      const msg = String(e?.message ?? e).split('\n')[0];
      logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: false, error: msg, headed, display: screen.display });
      if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENOTFOUND/i.test(msg)) {
        return `打不开 ${raw}：网址不存在或网络不通（${msg}）。`;
      }
      if (/ERR_CONNECTION|ERR_TIMED_OUT|Timeout/i.test(msg)) {
        return `打不开 ${raw}：连接超时或对方没有响应。可能是网站屏蔽了服务器访问，或网络不通。`;
      }
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/i.test(msg)) {
        return `打不开 ${raw}：代理连接失败。可能是网络出口限制了浏览器访问。`;
      }
      return `打不开 ${raw}：${msg}`;
    }
    const status = response?.status() ?? 0;
    if (status === 401 || status === 403) {
      logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: false, error: `HTTP ${status}`, headed, display: screen.display });
      return `打开 ${raw} 失败：HTTP ${status}，网站拒绝了访问——可能是需要登录，或者屏蔽了服务器 IP。请把正文复制给我，或换一个能打开的来源。`;
    }
    if (status >= 400) {
      logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: false, error: `HTTP ${status}`, headed, display: screen.display });
      return `打开 ${raw} 失败：HTTP ${status}。`;
    }
    // Let JS-heavy pages finish rendering; a slow page just costs the wait.
    try {
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS });
    } catch {
      // Still usable — the page may keep polling; continue with what rendered.
    }
    await page.waitForTimeout(1500).catch(() => {});

    const { title, text, links } = await extractPage(page);
    const clean = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const shot = await saveShot(page, screen);
    lastPageBySlug.set(screen.slug, { url: raw, title, at: new Date().toISOString() });
    logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: true, status, title: title.slice(0, 120), text_chars: clean.length, ms: Date.now() - started, headed, display: screen.display, screenshot: shot ? screen.screenshotPath : null });

    const screenNote = headed
      ? `（已在你的屏幕 :${screen.display} 上打开，截图保存在 data/screenshots/${screen.slug}-latest.png）`
      : `（注：你的虚拟屏幕 :${screen.display} 未启动，本次用无头模式打开；截图仍已保存。）`;

    if (CAPTCHA_RE.test(clean) && clean.length < 3000) {
      return `打开 ${raw} 后只看到人机验证（验证码），拿不到正文内容。这种页面浏览器也绕不过去，请把正文复制给我，或换一个来源。${screenNote}`;
    }
    if (LOGIN_WALL_RE.test(clean) && clean.length < 800) {
      return `打开 ${raw} 后只看到登录提示，拿不到正文内容。这个页面需要登录才能看完整内容，请把正文复制给我，或换一个能打开的来源。${screenNote}`;
    }
    if (!clean) {
      return `打开 ${raw} 后没有可读文字。可能是纯图片/视频页，或内容需要登录才能加载。${screenNote}`;
    }
    let out = `标题：${title || '(无标题)'}\n网址：${raw}\n\n${clean.slice(0, MAX_TEXT_CHARS)}`;
    if (clean.length > MAX_TEXT_CHARS) out += `\n…(正文截断到 ${MAX_TEXT_CHARS} 字)`;
    if (links.length) {
      out += `\n\n相关链接：\n${links.map((l) => `- ${l.text} — ${l.href}`).join('\n')}`;
    }
    out += `\n\n${screenNote}`;
    return out;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split('\n')[0];
    logCall({ tool: 'browse_page', bot: screen.slug, url: raw, ok: false, error: msg, headed, display: screen.display });
    return `打开 ${raw} 时出错：${msg}`;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/**
 * Screenshot the page this bot last opened, on its own screen, and save it
 * to data/screenshots/<bot>-latest.png. Re-opens the last URL (browsers
 * close after each browse_page call, so there is no page kept open).
 * Returns the saved path, or a short Chinese notice when there is nothing
 * to screenshot yet.
 */
export async function takeScreenshot(bot: { id: string; name: string }): Promise<string> {
  const screen = botScreen(bot);
  const last = lastPageBySlug.get(screen.slug);
  if (!last) return '你还没有用 browse_page 打开过任何页面。先打开一个页面，再截图。';

  let ctx: BrowserContext | null = null;
  let headed = false;
  try {
    try {
      ({ context: ctx, headed } = await launchBotContext(screen));
    } catch (e: any) {
      logCall({ tool: 'take_screenshot', bot: screen.slug, url: last.url, ok: false, error: `launch failed: ${e?.message ?? e}` });
      return `浏览器启动失败，截不到图：${e?.message ?? e}。可能是浏览器还没装好（服务器上重跑 deploy.sh 里的 4c 步），请告诉用户。`;
    }
    const page = await ctx.newPage();
    try {
      await page.goto(last.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (e: any) {
      const msg = String(e?.message ?? e).split('\n')[0];
      logCall({ tool: 'take_screenshot', bot: screen.slug, url: last.url, ok: false, error: msg, headed, display: screen.display });
      return `重新打开 ${last.url} 失败，截不到图：${msg}`;
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS });
    } catch {
      // Continue with what rendered.
    }
    await page.waitForTimeout(1000).catch(() => {});
    const shot = await saveShot(page, screen);
    logCall({ tool: 'take_screenshot', bot: screen.slug, url: last.url, ok: shot, headed, display: screen.display, screenshot: screen.screenshotPath });
    if (!shot) return '截图保存失败（写文件出错）。请告诉用户。';
    return `截图已保存：data/screenshots/${screen.slug}-latest.png（页面：${last.title || last.url}，你的屏幕 :${screen.display}${headed ? '' : '，无头模式'}）。`;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split('\n')[0];
    logCall({ tool: 'take_screenshot', bot: screen.slug, url: last.url, ok: false, error: msg, headed, display: screen.display });
    return `截图时出错：${msg}`;
  } finally {
    await ctx?.close().catch(() => {});
  }
}
