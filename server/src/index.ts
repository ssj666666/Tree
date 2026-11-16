import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { api } from './routes.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { startMemoryConsolidation } from './agent/memory.js';
import { db } from './db.js';
import { ensureTeamBots } from './team.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();

// Tree step 5: users created before Forge/Ledger/Brief existed get the
// missing team bots on boot. ensureTeamBots is idempotent and records a
// per-user flag, so it never resurrects a bot the user deleted.
for (const u of db.prepare('SELECT id FROM users').all() as { id: string }[]) ensureTeamBots(u.id);

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, model: env.deepseekModel }));
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[tree] server on http://localhost:${info.port} (model ${env.deepseekModel})`));
// TREE_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.TREE_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[tree] scheduler disabled (TREE_NO_SCHEDULER=1)');
startIdleWatcher();
startMemoryConsolidation();
