import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, getBotRow, listRoutines, toRoutine, describeCron } from '../store.js';
import { executeComposio, innerToolSlugs, isReadOnlySlug, toolkitInfo } from '../composio.js';
import { scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { createEventRoutine, deleteEventTrigger, describeEvent, listTriggerTypes } from '../triggers.js';
import { bochaSearch } from './websearch.js';
import { fetchPage, readFile, runShell, writeFile } from './localtools.js';
import { browsePage, takeScreenshot } from './browsertools.js';
import { draftEmail, readEmail, readInbox, sendEmail } from './emailtools.js';
import { setCheckins } from '../proactive.js';
import { createSubagent, deleteSubagent, listSubagents } from './subagents.js';
import { createRoom, postToRoom } from './rooms.js';
import type { ActivityKind } from '../types.js';
import { Cron } from 'croner';

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
}

export interface ToolResult {
  /** Responses API function_call_output.output: string or content array (text + images). */
  output: string | any[];
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
}

type Impl = (args: any, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, name.trim()) as any;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'remember',
    description: 'Save a durable memory about the user, their preferences, or your job, so you remember it in future conversations.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    activity: 'remembering',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run(newId('mem'), ctx.botId, String(a.text), now());
      return { output: 'Saved to memory.', summary: 'Saved a memory' };
    },
  },
  {
    name: 'recall',
    description: 'Search your saved memories.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    activity: 'remembering',
    label: 'Searching memory',
    impl: async (a, ctx) => {
      const words = String(a.query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const all = db.prepare('SELECT text, created_at FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(ctx.botId) as any[];
      const hits = all.filter((m) => !words.length || words.some((w) => m.text.toLowerCase().includes(w))).slice(0, 20);
      return { output: JSON.stringify(hits.map((h) => h.text)) };
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information (news, prices, docs, anything you do not already know). Returns up to 5 results with title, link and a short snippet. If search is not configured, the result says so: tell the user and do not invent results.',
    parameters: obj({ query: { type: 'string', description: 'What to search for, e.g. "DeepSeek V4.1 Flash pricing"' }, count: { type: 'integer', description: 'How many results (1-5, default 5)' } }, ['query']),
    activity: 'searching_web',
    label: 'Searching the web',
    impl: async (a) => ({ output: await bochaSearch(String(a.query ?? ''), Number(a.count ?? 5)), summary: 'Searched the web' }),
  },
  // Step 3.1 — local hands: act directly on this server (no cloud computer).
  {
    name: 'run_shell',
    description: 'Run one bash command on this Linux server (as root) and get its output. Working directory is the workspace (or /tmp). Use for commands, git (add/commit — pushing stays with the operator), and quick data work. Commands touching .env or API keys, dumping the whole environment, or destructive commands (rm -rf /, mkfs, dd, reboot) are refused. Output is capped at ~6000 characters.',
    parameters: obj({ command: { type: 'string', description: 'The shell command to run, e.g. "ls -la" or "git -C /root/tree status"' }, cwd: { type: 'string', description: 'Working directory, inside the workspace or /tmp (default: workspace root)' } }, ['command']),
    activity: 'running_commands',
    label: 'Running commands',
    impl: async (a) => {
      const r = await runShell(String(a.command ?? ''), a.cwd ? String(a.cwd) : undefined);
      return { output: JSON.stringify(r), summary: r.exit_code === null ? 'Refused / failed' : `exit ${r.exit_code}` };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file inside the workspace directory. Returns the file contents (capped at ~20000 characters). Credential files (.env, *.key, *.pem, *password*) cannot be read.',
    parameters: obj({ path: { type: 'string', description: 'Path inside the workspace, e.g. "notes.md" or "server/src/agent/tools.ts"' } }, ['path']),
    activity: 'drafting_file',
    label: 'Reading a file',
    impl: async (a) => ({ output: readFile(String(a.path ?? '')), summary: 'Read a file' }),
  },
  {
    name: 'write_file',
    description: 'Write a text file inside the workspace directory (parent folders are created). Use for notes, reports, code, and anything you produce. Credential files (.env, *.key, *.pem, *password*) cannot be written.',
    parameters: obj({ path: { type: 'string', description: 'Path inside the workspace, e.g. "notes.md"' }, content: { type: 'string', description: 'The full file contents' } }, ['path', 'content']),
    activity: 'drafting_file',
    label: 'Writing a file',
    impl: async (a) => ({ output: writeFile(String(a.path ?? ''), String(a.content ?? '')), summary: 'Wrote a file' }),
  },
  {
    name: 'fetch_page',
    description: 'Open a URL and read it as plain text (up to ~8000 characters). Use for a link web_search found. This reads the static page only — no JavaScript runs, so JS-heavy pages (e.g. Douyin) return little or no text; say so instead of guessing.',
    parameters: obj({ url: { type: 'string', description: 'The http(s) URL to open' } }, ['url']),
    activity: 'reading_web',
    label: 'Opening a page',
    impl: async (a) => ({ output: await fetchPage(String(a.url ?? '')), summary: 'Opened a page' }),
  },
  // Step 6 — email (one mailbox over IMAP/SMTP). Sending is draft-first:
  // draft_email creates the draft, the user approves it in chat, and only
  // then does send_email send that draft (once). There is no direct-send tool.
  {
    name: 'read_inbox',
    description: 'List the most recent emails in the inbox (sender, subject, date, snippet). Use to check what came in. If email is not configured, the result says so: tell the user and do not invent emails.',
    parameters: obj({ limit: { type: 'integer', description: 'How many recent emails (1-20, default 10)' } }),
    activity: 'reading_web',
    label: 'Reading email',
    impl: async (a) => ({ output: await readInbox(Number(a.limit ?? 10)), summary: 'Read inbox' }),
  },
  {
    name: 'read_email',
    description: 'Read one email in full by its uid (from read_inbox). Returns sender, subject, date and the text body (capped at ~8000 characters) plus attachment names.',
    parameters: obj({ uid: { type: 'integer', description: 'The uid from read_inbox' } }, ['uid']),
    activity: 'reading_web',
    label: 'Reading email',
    impl: async (a) => ({ output: await readEmail(Number(a.uid)), summary: 'Read an email' }),
  },
  {
    name: 'draft_email',
    description: 'Write an email draft (does NOT send). Show the draft to the user first; only call send_email after the user explicitly says to send that draft.',
    parameters: obj({ to: { type: 'string', description: 'Recipient email address' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain-text body' } }, ['to', 'subject', 'body']),
    activity: 'drafting_file',
    label: 'Drafting email',
    impl: async (a, ctx) => {
      const r = draftEmail(ctx.userId, ctx.botId, String(a.to ?? ''), String(a.subject ?? ''), String(a.body ?? ''));
      if ('error' in r) return { output: r.error };
      return { output: JSON.stringify({ draft_id: r.id, to: r.to, subject: r.subject, preview: r.body.slice(0, 300) }), summary: 'Drafted an email' };
    },
  },
  {
    name: 'send_email',
    description: 'Send a draft created by draft_email, by its draft_id. Only call this after the user has seen the draft and explicitly said to send it. Each draft can only be sent once.',
    parameters: obj({ draft_id: { type: 'string', description: 'The draft_id from draft_email' } }, ['draft_id']),
    activity: 'messaging_named',
    label: 'Sending email',
    impl: async (a, ctx) => ({ output: await sendEmail(ctx.userId, String(a.draft_id ?? '')), summary: 'Sent an email' }),
  },
  {
    name: 'browse_page',
    description: 'Open a URL in a real browser (Chromium) that runs JavaScript, wait for the page to render, and read its visible text (up to ~8000 characters) plus title and key links. It opens on YOUR OWN virtual screen (Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15) with your own persistent browser profile (your logins/cookies stay yours, per bot), and saves a screenshot to data/screenshots/<your-name>-latest.png. Use this when fetch_page returns little or no text, or for JS-heavy pages (e.g. Zhihu hot list, JS-rendered news). It cannot log in, pass captchas, or read paywalled/member-only content: if the page blocks access, the result says so — tell the user instead of guessing.',
    parameters: obj({ url: { type: 'string', description: 'The http(s) URL to open in the browser' } }, ['url']),
    activity: 'reading_web',
    label: 'Browsing a page',
    impl: async (a, ctx) => ({ output: await browsePage(String(a.url ?? ''), { id: ctx.botId, name: getBotName(ctx.botId) }), summary: 'Browsed a page' }),
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the page you last opened in your own browser (your own virtual screen) and save it to data/screenshots/<your-name>-latest.png. Returns the saved file path. Use when the user asks to see what you are looking at on your screen. If you have not opened any page yet, it says so.',
    parameters: obj({}),
    activity: 'reading_web',
    label: 'Taking a screenshot',
    impl: async (_a, ctx) => ({ output: await takeScreenshot({ id: ctx.botId, name: getBotName(ctx.botId) }), summary: 'Took a screenshot' }),
  },
  {
    name: 'save_file',
    description: "Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under files/<your id>/ in the workspace on this server — the Library tab lists it there.",
    parameters: obj({ filename: { type: 'string', description: 'e.g. briefing-2026-11-09.md' }, content: { type: 'string' } }, ['filename', 'content']),
    activity: 'drafting_file',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      const name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file.txt';
      if (name === '.env' || name.endsWith('.key') || name.endsWith('.pem') || name.includes('password')) {
        return { output: 'Refused: credential files cannot be saved this way.' };
      }
      const content = String(a.content ?? '');
      if (content.length > 5_000_000) return { output: 'Refused: file is too large (over 5 MB of text). Split it or save it in parts.' };
      const dir = path.join(path.resolve(env.workspace), 'files', ctx.botId);
      const target = path.join(dir, name);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      } catch (e: any) {
        return { output: `Could not save ${name}: ${e?.message ?? e}` };
      }
      return { output: JSON.stringify({ ok: true, path: `files/${ctx.botId}/${name}` }), summary: `Saved ${name}` };
    },
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || 'UTC' }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
    },
  },
  {
    name: 'list_event_triggers',
    description: 'List the event triggers a connected app offers (e.g. new email, new Slack message, new GitHub PR), with each trigger\'s config fields. Use before create_event_routine.',
    parameters: obj({ toolkit: { type: 'string', description: 'Composio toolkit slug, e.g. gmail, slack, github, googlecalendar' } }, ['toolkit']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a) => ({ output: JSON.stringify(await listTriggerTypes(String(a.toolkit).toLowerCase())) }),
  },
  {
    name: 'create_event_routine',
    description: 'Create a routine that runs whenever an event happens in a connected app (instead of on a schedule). `trigger_slug` comes from list_event_triggers; `config_json` is a JSON object string with that trigger\'s config fields (use "{}" if none). `prompt` is what you will do each time, given the event payload.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, trigger_slug: { type: 'string' }, config_json: { type: 'string' } }, ['name', 'prompt', 'trigger_slug']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      let config: Record<string, unknown> = {};
      try { config = a.config_json ? JSON.parse(a.config_json) : {}; } catch { return { output: 'config_json must be a JSON object string.' }; }
      try {
        const r = await createEventRoutine(ctx.userId, ctx.botId, { name: a.name, prompt: a.prompt, trigger_slug: a.trigger_slug, config });
        appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeEvent(`event:${String(a.trigger_slug).toUpperCase()}`)}`, ref: r.id });
        hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
        return { output: JSON.stringify({ ok: true, routine_id: r.id }), summary: `Created event routine ${a.name}` };
      } catch (e: any) {
        return { output: `Could not create the trigger: ${e?.message ?? e}. If the app isn't connected, call request_app_connection first.` };
      }
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id));
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      unscheduleRoutine(a.routine_id);
      await deleteEventTrigger(a.routine_id);
      db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once).',
    parameters: obj({ title: { type: 'string' } }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const id = newId('task');
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, ctx.botId, a.title, now(), now());
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: JSON.stringify({ task_id: id }) };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task: state is working, needs_input, or done.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: ['working', 'needs_input', 'done'] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=? AND bot_id=?').run(a.state, a.note ?? null, now(), a.task_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: 'Updated.' };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' } }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${(db.prepare('SELECT name FROM bots WHERE user_id=?').all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'spawn_subagent',
    description: 'Start a subagent: a helper copy of you with its own context and its own computer screen, to work on one goal in parallel (e.g. research one company each). It reports back to you as a message when done. Max 4 at a time.',
    parameters: obj({ goal: { type: 'string', description: 'Self-contained task with everything the subagent needs to know' }, label: { type: 'string', description: 'Short name, e.g. "Acme research"' } }, ['goal']),
    activity: 'messaging_named',
    label: 'Starting a helper',
    impl: async (a, ctx) => {
      if (ctx.depth >= 2) return { output: 'Subagents cannot start more subagents. Do the work yourself.' };
      try {
        const sub = createSubagent(ctx.botId, String(a.goal), a.label);
        ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.goal), ctx.depth + 1);
        return { output: JSON.stringify({ ok: true, subagent_id: sub.id, name: sub.name, note: 'It will report back to you as a message. Continue with other work or end your turn.' }), summary: `Started ${sub.name}` };
      } catch (e: any) {
        return { output: String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'list_subagents',
    description: 'List your subagents with their status and latest message.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking on helpers',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listSubagents(ctx.botId)) }),
  },
  {
    name: 'message_subagent',
    description: 'Send a follow-up instruction to one of your subagents.',
    parameters: obj({ subagent_id: { type: 'string' }, message: { type: 'string' } }, ['subagent_id', 'message']),
    activity: 'messaging_named',
    label: 'Checking with a helper',
    impl: async (a, ctx) => {
      const sub = db.prepare('SELECT id FROM bots WHERE id=? AND parent_bot_id=?').get(a.subagent_id, ctx.botId) as any;
      if (!sub) return { output: 'No such subagent.' };
      ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.message), ctx.depth + 1);
      return { output: 'Sent.' };
    },
  },
  {
    name: 'stop_subagent',
    description: 'Stop and remove one of your subagents (do this once you have its result).',
    parameters: obj({ subagent_id: { type: 'string' } }, ['subagent_id']),
    activity: 'working',
    label: 'Wrapping up a helper',
    impl: async (a, ctx) => {
      const { interrupt } = await import('./loop.js');
      interrupt(String(a.subagent_id));
      return { output: deleteSubagent(ctx.botId, String(a.subagent_id)) ? 'Stopped and removed.' : 'No such subagent.' };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' } }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text));
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      appendRow(ctx.botId, 'card', { type: 'card', card: 'question', question: a.question, options: (a.options ?? []).slice(0, 6), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },
  {
    name: 'request_app_connection',
    description: 'Ask the user to connect an app (e.g. gmail, googlecalendar, slack, github, notion, linear) so you can use it. Use the Composio toolkit slug.',
    parameters: obj({ toolkit: { type: 'string' }, reason: { type: 'string' } }, ['toolkit', 'reason']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a, ctx) => {
      const info = await toolkitInfo(String(a.toolkit).toLowerCase());
      if (!info) return { output: `Unknown toolkit "${a.toolkit}". Use COMPOSIO_SEARCH_TOOLS to find the right toolkit slug.` };
      appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', toolkit: info.slug, toolkitName: info.name, logo: info.logo, reason: a.reason, status: 'pending' });
      return { output: `Asked the user to connect ${info.name}. Stop here; you'll be told when it's connected.`, endTurn: true };
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export function functionSchemas() {
  return TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

// ---------- approvals policy ----------

export type Decision = 'allow' | 'ask' | 'block';

export function policyFor(userId: string, toolName: string, args: any): { decision: Decision; key: string; toolkit?: string; title: string } {
  if (toolMap.has(toolName)) return { decision: 'allow', key: toolName, title: toolName };
  const slugs = innerToolSlugs(toolName, args);
  if (!slugs.length) return { decision: 'allow', key: toolName, title: toolName };
  let decision: Decision = 'allow';
  let key = slugs[0];
  for (const slug of slugs) {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, slug) as any;
    const mode = p?.mode ?? (isReadOnlySlug(slug) ? 'always_allow' : 'needs_approval');
    if (mode === 'blocked') return { decision: 'block', key: slug, title: humanizeSlug(slug) };
    if (mode === 'needs_approval') { decision = 'ask'; key = slug; }
  }
  return { decision, key, toolkit: key.split('_')[0].toLowerCase(), title: humanizeSlug(key) };
}

export function humanizeSlug(slug: string) {
  const parts = slug.split('_');
  const app = parts.shift() ?? '';
  return `${app.charAt(0) + app.slice(1).toLowerCase()}: ${parts.join(' ').toLowerCase()}`;
}

export async function runComposioTool(ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const r = await executeComposio(ctx.userId, name, args);
  const ok = r.resultType ? r.resultType === 'completed' : !r.error;
  const payload = ok ? r.data : { error: r.error, logId: r.logId };
  let out = JSON.stringify(payload ?? null);
  if (out.length > 60000) out = out.slice(0, 60000) + '…(truncated)';
  return { output: out, summary: ok ? 'done' : 'failed' };
}

export function activityFor(name: string): { kind: ActivityKind; label: string } {
  const t = toolMap.get(name);
  if (t) return { kind: t.activity, label: t.label };
  if (name === 'COMPOSIO_SEARCH_TOOLS' || name === 'COMPOSIO_GET_TOOL_SCHEMAS') return { kind: 'connecting_service', label: 'Using a connected app' };
  return { kind: 'connecting_service', label: 'Using a connected app' };
}

export function getBotName(botId: string) {
  return getBotRow(botId)?.name ?? 'Bot';
}
