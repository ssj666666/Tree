import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

/**
 * Tree step 3.1 — "local hands".
 *
 * The bots run on this Linux server, so they can act on it directly instead
 * of through a (not connected) Orgo cloud computer: run shell commands,
 * read/write files in the workspace, and fetch web pages as plain text.
 *
 * Safety (the server runs as root — take this seriously):
 * - Everything is scoped to the workspace directory (env TREE_WORKSPACE,
 *   default /root/tree). Paths are resolved and rejected if they escape it.
 * - run_shell refuses secret-exposing commands (.env, API keys, wholesale
 *   env dumps) and destructive commands (rm -rf /, mkfs, dd, reboot...).
 * - The child shell gets a scrubbed environment: API keys and the admin
 *   password hash are removed, so even a sneaky `$VAR` expansion finds
 *   nothing.
 * - Every shell invocation is logged to data/tool-calls.log (data/ is
 *   git-ignored).
 *
 * Known limits (see STEP3-NOTES.md): no headless browser — fetch_page only
 * reads the static HTML, so JS-heavy pages (e.g. Douyin) return little
 * text. No git push: the server's GitHub reachability is untested, so
 * pushing stays with the operator; local commits are fine.
 */

const WORKSPACE = (() => {
  try {
    return fs.realpathSync(path.resolve(env.workspace));
  } catch {
    return path.resolve(env.workspace);
  }
})();

const LOG_FILE = path.join(WORKSPACE, 'data', 'tool-calls.log');

const SECRET_KEYS = [
  'DEEPSEEK_API_KEY',
  'BOCHA_API_KEY',
  'COMPOSIO_API_KEY',
  'ORGO_API_KEY',
  'TREE_ADMIN_PASSWORD_HASH',
  'PASSWORD_HASH',
  'SESSION_SECRET',
];

/** Env passed to the agent's shell: everything except secrets. */
function scrubbedEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of SECRET_KEYS) delete out[k];
  return out;
}

export function logCall(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('[localtools] could not write tool log:', e);
  }
}

/** Resolve a path inside the workspace; throw if it escapes (incl. symlinks). */
function resolveWorkspacePath(p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE, p);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      // Parent does not exist yet (e.g. a new file): fall back to the
      // lexical path; the relative check below still applies.
    }
  }
  const rel = path.relative(WORKSPACE, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace (${WORKSPACE}): ${p}`);
  }
  return real;
}

/** Filenames that must never be read or written by the bots (credentials). */
function isSecretFile(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.endsWith('.key') || base.endsWith('.pem')) return true;
  if (base.includes('password')) return true;
  return false;
}

// ---------- run_shell ----------

const MAX_SHELL_OUTPUT = 6000;
const SHELL_TIMEOUT_MS = 60_000;

/** Split a shell line into segments separated by ; && || | (quotes ignored — this is a deny check, false positives are fine). */
function shellSegments(command: string): string[] {
  return command.split(/(?:;|&&|\|\|?)/).map((s) => s.trim()).filter(Boolean);
}

/** Refuse the command, or return null to allow it. */
function denyShell(command: string): string | null {
  const lower = command.toLowerCase();

  // 1. Secret exposure: any mention of credential files or key names.
  if (/\.env(\b|$)/i.test(command)) return 'Refused: commands touching .env files are not allowed (credentials live there).';
  for (const k of SECRET_KEYS) {
    if (lower.includes(k.toLowerCase())) return `Refused: commands mentioning ${k} are not allowed.`;
  }

  for (const seg of shellSegments(command)) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    const first = (tokens[0] ?? '').toLowerCase();
    const rest = tokens.slice(1);

    // 2. Wholesale environment dumps.
    if (first === 'env' || first === 'printenv') return 'Refused: dumping the whole environment is not allowed.';
    if (first === 'export' && (rest.length === 0 || rest[0] === '-p')) return 'Refused: dumping the whole environment is not allowed.';
    if (first === 'set' && rest.length === 0) return 'Refused: dumping the whole environment is not allowed.';

    // 3. Destructive / system commands.
    if (['mkfs', 'mkfs.ext4', 'dd', 'shutdown', 'reboot', 'poweroff', 'halt'].includes(first)) {
      return `Refused: "${first}" is a destructive command and is not allowed.`;
    }
    if (first === 'chmod' && rest.includes('777')) {
      const target = rest.filter((t) => !t.startsWith('-')).pop();
      if (target === '/' || target === WORKSPACE || target === '/root') {
        return 'Refused: chmod 777 on the system or workspace root is not allowed.';
      }
    }
    if (first === 'rm') {
      const flags = rest.filter((t) => t.startsWith('-')).join('');
      const recursive = flags.includes('r') || rest.includes('--recursive');
      const force = flags.includes('f') || rest.includes('--force');
      if (recursive && force) {
        for (const target of rest.filter((t) => !t.startsWith('-'))) {
          const resolved = target === '~' || target === '$HOME' ? '/root'
            : target === '.' || target === '..' ? path.resolve(WORKSPACE)
            : path.resolve(WORKSPACE, target);
          if (resolved === '/' || resolved === WORKSPACE || WORKSPACE.startsWith(resolved + path.sep)) {
            return `Refused: "rm -rf ${target}" would delete the system or the workspace itself.`;
          }
        }
      }
    }
  }
  return null;
}

export interface ShellResult {
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  output: string;
}

export function runShell(command: string, cwd?: string): Promise<ShellResult> {
  const cmd = String(command ?? '').trim();
  return new Promise((resolve) => {
    if (!cmd) {
      resolve({ exit_code: null, timed_out: false, truncated: false, output: 'Empty command.' });
      return;
    }
    const denied = denyShell(cmd);
    if (denied) {
      logCall({ tool: 'run_shell', command: cmd, exit_code: null, denied: true });
      resolve({ exit_code: null, timed_out: false, truncated: false, output: denied });
      return;
    }
    // Working directory: workspace, or /tmp. Anything else is refused.
    let dir = WORKSPACE;
    if (cwd) {
      const resolved = path.resolve(cwd);
      if (resolved !== WORKSPACE && resolved !== '/tmp' && !resolved.startsWith(WORKSPACE + path.sep) && !resolved.startsWith('/tmp/')) {
        resolve({ exit_code: null, timed_out: false, truncated: false, output: `Refused: working directory must be inside the workspace (${WORKSPACE}) or /tmp, not ${cwd}.` });
        return;
      }
      dir = resolved;
    }
    execFile('bash', ['-c', cmd], { cwd: dir, timeout: SHELL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: scrubbedEnv() }, (err, stdout, stderr) => {
      const timedOut = (err as any)?.code === 'ETIMEDOUT';
      let output = (stdout ?? '') + (stderr ? `\n[stderr]\n${stderr}` : '');
      let truncated = false;
      if (output.length > MAX_SHELL_OUTPUT) {
        output = output.slice(0, MAX_SHELL_OUTPUT) + `\n…(output truncated to ${MAX_SHELL_OUTPUT} characters)`;
        truncated = true;
      }
      const exitCode = timedOut ? null : err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      logCall({ tool: 'run_shell', command: cmd, exit_code: exitCode, timed_out: timedOut });
      resolve({ exit_code: exitCode, timed_out: timedOut, truncated, output: output || '(no output)' });
    });
  });
}

// ---------- read_file / write_file ----------

const MAX_READ_CHARS = 20_000;
const MAX_WRITE_CHARS = 200_000;

export function readFile(p: string): string {
  const target = String(p ?? '').trim();
  if (!target) return 'No path given.';
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(target);
  } catch (e: any) {
    return `Refused: ${e?.message ?? e}`;
  }
  if (isSecretFile(resolved)) return 'Refused: credential files (.env, *.key, *.pem, *password*) cannot be read.';
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (e: any) {
    return `Could not read ${target}: ${e?.message ?? e}`;
  }
  if (content.length > MAX_READ_CHARS) {
    return content.slice(0, MAX_READ_CHARS) + `\n…(file truncated to ${MAX_READ_CHARS} characters; the file is ${content.length} characters long)`;
  }
  return content;
}

export function writeFile(p: string, content: string): string {
  const target = String(p ?? '').trim();
  const text = String(content ?? '');
  if (!target) return 'No path given.';
  if (text.length > MAX_WRITE_CHARS) return `Refused: content is ${text.length} characters, over the ${MAX_WRITE_CHARS}-character limit. Split it into smaller writes.`;
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(target);
  } catch (e: any) {
    return `Refused: ${e?.message ?? e}`;
  }
  if (isSecretFile(resolved)) return 'Refused: credential files (.env, *.key, *.pem, *password*) cannot be written.';
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, 'utf8');
  } catch (e: any) {
    return `Could not write ${target}: ${e?.message ?? e}`;
  }
  logCall({ tool: 'write_file', path: resolved, bytes: Buffer.byteLength(text, 'utf8') });
  return JSON.stringify({ ok: true, path: resolved, bytes: Buffer.byteLength(text, 'utf8') });
}

// ---------- fetch_page ----------

const MAX_FETCH_CHARS = 8000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(noscript|template|svg|head)[\s\S]*?<\/(noscript|template|svg|head)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

export async function fetchPage(url: string): Promise<string> {
  const raw = String(url ?? '').trim();
  if (!raw) return 'No URL given.';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `Invalid URL: ${raw}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Only http(s) URLs are supported.';
  }
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Tree/1.0 (personal agent; +https://github.com/ssj666666/Tree)', Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
  } catch (e: any) {
    return `Could not fetch ${raw}: ${e?.message ?? e}`;
  }
  if (!res.ok) return `Fetching ${raw} failed: HTTP ${res.status}.`;
  // Bound memory: only parse the first ~500k characters of the page.
  const html = (await res.text()).slice(0, 500_000);
  const text = htmlToText(html);
  if (!text) {
    // NOTE: this tool reads static HTML only — no headless browser, no
    // JavaScript. JS-heavy pages (e.g. Douyin) render almost nothing here.
    return `Fetched ${raw} but no readable text was found. The page probably needs JavaScript to render (e.g. Douyin), which this tool cannot run — try web_search for it instead.`;
  }
  if (text.length > MAX_FETCH_CHARS) {
    return text.slice(0, MAX_FETCH_CHARS) + `\n…(page truncated to ${MAX_FETCH_CHARS} characters)`;
  }
  return text;
}
