import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { db, now } from './db.js';
import { env } from './env.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow, listRoutines, listTasks } from './store.js';
import { computerState } from './computer.js';
import { botScreen } from './agent/browsertools.js';
import { runInBotQueue } from './agent/loop.js';
import { consolidateBot, historySize, maybeCompact, memoryConfig } from './agent/memory.js';
import { idleConfig, viewerCount } from './idle.js';
import { loadHistory } from './store.js';
import type { LibraryFile, Memory, Skill } from './types.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

const execFileAsync = promisify(execFile);

for (const p of ['/bots/*', '/skills/*', '/computer/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const toMemory = (m: any): Memory => ({ id: m.id, botId: m.bot_id, text: m.text, createdAt: m.created_at, source: m.source === 'learned' ? 'learned' : 'chat' });
const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const memories = (db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(b.id) as any[]).map(toMemory);
  const job = db.prepare('SELECT last_consolidated_at, last_result FROM memory_jobs WHERE bot_id=?').get(b.id) as any;
  const lastCompaction = db.prepare('SELECT method, items_before, items_after, chars_before, chars_after, created_at FROM compactions WHERE bot_id=? ORDER BY id DESC LIMIT 1').get(b.id) as any;
  return c.json({
    memories,
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    memory: {
      lastConsolidatedAt: job?.last_consolidated_at ?? null,
      historyChars: historySize(b.id, loadHistory(b.id)),
      compactAtChars: memoryConfig.compactChars,
      lastCompaction: lastCompaction ?? null,
    },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- memory maintenance ----------

/** Run consolidation now instead of waiting for the idle window. */
configApi.post('/bots/:id/memories/consolidate', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await consolidateBot(b.id));
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502);
  }
});

/** Compact the stored history now (inside the bot's queue). `force` compacts even under the threshold. */
configApi.post('/bots/:id/compact', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const force = c.req.query('force') === '1';
  const before = loadHistory(b.id).length;
  const after = await runInBotQueue(b.id, async () => (await maybeCompact(b.id, loadHistory(b.id), { force })).length);
  return c.json({ itemsBefore: before, itemsAfter: after, compacted: after !== before });
});

// ---------- library: files under <workspace>/files/<botId> on this server ----------

/** The Library root: files the bots save (via save_file) live here. */
const LIB_ROOT = path.join(path.resolve(env.workspace), 'files');

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

/** Resolve a Library path inside the bot's own folder; null when it escapes it. */
function libPath(botId: string, rel: string): string | null {
  const base = path.join(LIB_ROOT, botId);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function listLibDir(dir: string): LibraryFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: LibraryFile[] = [];
  for (const e of entries) {
    try {
      const st = fs.statSync(path.join(dir, e.name));
      files.push({ name: e.name, size: st.isDirectory() ? 0 : st.size, modifiedAt: st.mtimeMs, isDir: st.isDirectory() });
    } catch { /* entry vanished mid-list; skip */ }
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  const dir = libPath(b.id, rel);
  if (!dir) return c.json({ error: 'bad path' }, 400);
  try {
    return c.json({ status: 'ok', path: rel, files: listLibDir(dir) });
  } catch (e: any) {
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const target = libPath(b.id, rel);
  try {
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return c.json({ error: 'file not found' }, 404);
  } catch {
    return c.json({ error: 'file not found' }, 404);
  }
  return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` });
});

/** Stream one Library file back to the browser (same-origin, cookie auth). */
configApi.get('/bots/:id/files/raw', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const target = libPath(b.id, rel);
  if (!target) return c.json({ error: 'bad path' }, 400);
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return c.json({ error: 'file not found' }, 404);
    const buf = fs.readFileSync(target);
    if (buf.length > 50_000_000) return c.json({ error: 'file too large to download here' }, 413);
    const name = path.basename(target);
    return c.body(buf, 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store' });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

// ---------- computer: screens, reset, hibernation ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const bots = db.prepare("SELECT id, name, updated_at FROM bots WHERE user_id=? AND kind<>'room'").all(userId) as any[];
  const screens = bots.map((bot) => {
    const screen = botScreen({ id: bot.id, name: bot.name });
    let lastUsedAt = bot.updated_at;
    try {
      const st = fs.statSync(screen.screenshotPath);
      lastUsedAt = Math.max(lastUsedAt, Math.floor(st.mtimeMs));
    } catch { /* no screenshot yet */ }
    return { botId: bot.id, screenId: `:${screen.display}`, lastUsedAt };
  });
  return c.json({
    computer: computerState(userId),
    screens,
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

/** Give a bot a clean screen: close its browser windows so it starts fresh next time. The Xvfb display itself persists. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const screen = botScreen({ id: b.id, name: b.name });
  try {
    await execFileAsync('pkill', ['-f', `user-data-dir=${screen.profileDir}`]).catch(() => null);
    try {
      for (const f of fs.readdirSync(screen.profileDir)) {
        if (f.startsWith('Singleton')) fs.rmSync(path.join(screen.profileDir, f), { force: true });
      }
    } catch { /* no profile yet; nothing to clean */ }
    console.log(`[computer] reset screen :${screen.display} for bot ${b.id}`);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true, screenId: `:${screen.display}` });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});
