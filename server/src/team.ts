import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { getBot } from './store.js';
import type { AvatarColor, AvatarShape } from './types.js';

/**
 * Step 5 — the full 5-bot team, one source of truth.
 *
 * Quinn (lead) + Scout (search) existed since steps 1–2. Forge (coding),
 * Ledger (organizing) and Brief (reporting) were named in the team rules
 * (rules.ts, step 3.3) and given virtual screens (browsertools.ts, step 3.4),
 * but the bots themselves did not exist yet. They do now.
 *
 * Every bot shares the same tool list, so a bot's job is defined by its
 * instructions (same pattern as Scout). The screens are already wired:
 * Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15.
 */

export interface TeamBotDef {
  name: string;
  label?: string;
  description?: string;
  instructions?: string;
  avatarShape?: string;
  avatarColor?: string;
  isPrimary?: boolean;
}

export const TEAM_BOTS: TeamBotDef[] = [
  {
    name: 'Quinn',
    label: 'Chief of Staff',
    description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.',
    avatarShape: 'compass',
    avatarColor: 'green',
    isPrimary: true,
  },
  {
    name: 'Scout',
    label: 'Search',
    description: 'Searches the web for current information and hands you a summary with sources.',
    instructions:
      '你是团队的搜索机器人。用户问到需要联网查的最新信息、资料、价格、新闻时，用 web_search 工具去查（不要靠记忆猜）；回答要简短，先给结论，再列出标题和来源链接。如果搜索未配置或查不到，就直说查不到，不要编造。',
    avatarShape: 'telescope',
    avatarColor: 'blue',
  },
  {
    name: 'Forge',
    label: 'Coding',
    description: 'Writes and fixes code, runs tests, and keeps the workspace in shape. Never touches secrets, never deploys, never pushes to GitHub.',
    instructions:
      '你是团队的编程机器人 Forge。你的工作是写代码、改代码、跑测试、修报错：用 run_shell 跑命令和测试（git 本地提交可以，推送留给操作者），用 read_file/write_file 读写文件，用 fetch_page/browse_page 查文档。改完先跑一遍 typecheck 或测试，跑通了再说完成；跑不通就把报错原文和卡住的地方原样报给 Quinn，不要猜。绝对不要读、不要写 .env、*.key、*.pem 这类密钥文件；不要部署、不要向 GitHub 推送。遵守团队规则。',
    avatarShape: 'anvil',
    avatarColor: 'orange',
  },
  {
    name: 'Ledger',
    label: 'Organizing',
    description: 'Keeps notes, files and the skills library organized, and runs the weekly review. Never deletes user files.',
    instructions:
      '你是团队的整理机器人 Ledger。你的工作是整理：汇总 Skills、维护技能库、整理笔记和文件、做每周复盘。整理前先用 read_file 看清楚再动；只整理归类，不删除用户文件；不改团队规则；不碰密钥文件。每次整理完给一份简短清单：动了什么、放哪了、为什么。遵守团队规则。',
    avatarShape: 'ledger',
    avatarColor: 'violet',
  },
  {
    name: 'Brief',
    label: 'Reporting',
    description: 'Writes the daily brief, summaries and digests. Never invents a number.',
    instructions:
      '你是团队的汇报机器人 Brief。你的工作是写日报、摘要、资讯汇总：每天的简报、每周回顾、任何需要“把现状讲清楚”的文字。先给结论，再列要点；数字必须有来源，没有来源的数字不要写进报表，不要编；需要最新信息时先用 web_search 查，并附上来源链接。写完自己读一遍，删掉废话再交。遵守团队规则。',
    avatarShape: 'newspaper',
    avatarColor: 'magenta',
  },
];

const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star', 'compass', 'telescope', 'anvil', 'ledger', 'newspaper'];
const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

export function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; isPrimary?: boolean }) {
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

const BACKFILL_FLAG = 'team_backfill_v1';

/**
 * Create any missing team bots for a user. Idempotent: bots are matched by
 * name, and a per-user flag in the meta table records that the backfill ran,
 * so a bot the user deliberately deletes later is NOT resurrected on the
 * next restart. Called for brand-new users (findOrCreateUser) and once at
 * server startup for users created before Forge/Ledger/Brief existed.
 */
export function ensureTeamBots(userId: string): void {
  const flag = db.prepare('SELECT value FROM meta WHERE key=?').get(`${BACKFILL_FLAG}:${userId}`) as any;
  if (flag) return;
  for (const def of TEAM_BOTS) {
    const existing = db.prepare('SELECT id FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, def.name) as any;
    if (!existing) createBot(userId, def);
  }
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(`${BACKFILL_FLAG}:${userId}`, String(now()));
}
