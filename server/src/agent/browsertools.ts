import { chromium, type Browser } from 'playwright';
import { env } from '../env.js';
import { logCall } from './localtools.js';

/**
 * Tree step 3.2 — "browser hands": a real headless browser.
 *
 * fetch_page (step 3.1) only reads static HTML, so JS-heavy pages render
 * almost nothing there. browse_page opens the URL in a real Chromium
 * (Playwright, headless), waits for JavaScript to run, and returns the
 * rendered text. No logins are ever filled in, no cookies or credentials
 * are stored persistently, and the browser profile is thrown away after
 * each call (fresh context every time).
 *
 * Safety / behaviour:
 * - Never throws: unreachable/blocked/captcha/login-wall pages return a
 *   short Chinese notice, so the conversation never crashes.
 * - Runs as root on the server, so Chromium gets --no-sandbox (the same
 *   reason headless CI containers use it).
 * - A proxy is used only if the standard HTTPS_PROXY/HTTP_PROXY env vars
 *   are set (the production server has direct internet and sets none).
 * - TREE_CHROMIUM_PATH may point at a system Chromium instead of the
 *   Playwright-bundled one (fallback if the bundled build cannot run).
 * - Every call is logged to data/tool-calls.log (URL + outcome only).
 *
 * glibc note (verified 2026-11-16, see STEP3.2-NOTES.md): Playwright
 * 1.65.1's bundled Chromium 159 needs at most GLIBC_2.25, and the
 * production server has glibc 2.32, so the bundled build should run
 * there. The deploy script still installs the system libraries and
 * smoke-tests a launch; this is UNVERIFIED on the server until then.
 */

const MAX_TEXT_CHARS = 8000;
const MAX_LINKS = 10;

/** Overall budget for one browse_page call (env TREE_BROWSE_TIMEOUT_MS, default 60s). */
const GOTO_TIMEOUT_MS = Math.min(30_000, Math.max(5_000, Math.floor(env.browseTimeoutMs * 0.5)));
const IDLE_TIMEOUT_MS = Math.min(15_000, Math.max(3_000, Math.floor(env.browseTimeoutMs * 0.25)));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

const CAPTCHA_RE = /captcha|人机验证|请验证|滑动验证|请完成验证|verify you are (not )?human|are you a robot/i;
const LOGIN_WALL_RE = /请登录|登录后查看|登录后才能|sign in to continue|log in to (view|continue)/i;

async function launchBrowser(): Promise<Browser> {
  const proxy = proxyFromEnv();
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-agent=${BROWSER_UA}`,
    ],
    ...(env.chromiumPath ? { executablePath: env.chromiumPath } : {}),
    ...(proxy ? { proxy } : {}),
  });
}

/** Rendered text + a few key links from the loaded page. */
async function extractPage(page: import('playwright').Page): Promise<{ title: string; text: string; links: { text: string; href: string }[] }> {
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

export async function browsePage(url: string): Promise<string> {
  const raw = String(url ?? '').trim();
  if (!raw) return '没有给网址。';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `网址无效：${raw}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return '只支持 http(s) 网址。';
  }

  const started = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
  } catch (e: any) {
    logCall({ tool: 'browse_page', url: raw, ok: false, error: `launch failed: ${e?.message ?? e}` });
    return `浏览器启动失败：${e?.message ?? e}。可能是浏览器还没装好（服务器上重跑 deploy.sh 里的 4c 步），请告诉用户。`;
  }

  try {
    const page = await browser.newPage({ userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 } });
    let response: import('playwright').Response | null = null;
    try {
      response = await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    } catch (e: any) {
      const msg = String(e?.message ?? e).split('\n')[0];
      logCall({ tool: 'browse_page', url: raw, ok: false, error: msg });
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
      logCall({ tool: 'browse_page', url: raw, ok: false, error: `HTTP ${status}` });
      return `打开 ${raw} 失败：HTTP ${status}，网站拒绝了访问——可能是需要登录，或者屏蔽了服务器 IP。请把正文复制给我，或换一个能打开的来源。`;
    }
    if (status >= 400) {
      logCall({ tool: 'browse_page', url: raw, ok: false, error: `HTTP ${status}` });
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
    logCall({ tool: 'browse_page', url: raw, ok: true, status, title: title.slice(0, 120), text_chars: clean.length, ms: Date.now() - started });

    if (CAPTCHA_RE.test(clean) && clean.length < 3000) {
      return `打开 ${raw} 后只看到人机验证（验证码），拿不到正文内容。这种页面浏览器也绕不过去，请把正文复制给我，或换一个来源。`;
    }
    if (LOGIN_WALL_RE.test(clean) && clean.length < 800) {
      return `打开 ${raw} 后只看到登录提示，拿不到正文内容。这个页面需要登录才能看完整内容，请把正文复制给我，或换一个能打开的来源。`;
    }
    if (!clean) {
      return `打开 ${raw} 后没有可读文字。可能是纯图片/视频页，或内容需要登录才能加载。`;
    }
    let out = `标题：${title || '(无标题)'}\n网址：${raw}\n\n${clean.slice(0, MAX_TEXT_CHARS)}`;
    if (clean.length > MAX_TEXT_CHARS) out += `\n…(正文截断到 ${MAX_TEXT_CHARS} 字)`;
    if (links.length) {
      out += `\n\n相关链接：\n${links.map((l) => `- ${l.text} — ${l.href}`).join('\n')}`;
    }
    return out;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split('\n')[0];
    logCall({ tool: 'browse_page', url: raw, ok: false, error: msg });
    return `打开 ${raw} 时出错：${msg}`;
  } finally {
    await browser.close().catch(() => {});
  }
}
