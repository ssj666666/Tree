import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { getBotRow } from './store.js';
import { botScreen } from './agent/browsertools.js';
import type { ComputerState } from './types.js';

/**
 * Tree step 4.2 — the "computer" is LOCAL.
 *
 * Orgo is gone (removed in step 4.2). There is no cloud computer, no Orgo
 * key, and no Orgo API call anywhere in this file. The computer is this
 * Linux server itself: it is awake exactly when the server is answering
 * requests, and it never sleeps.
 *
 * Each bot has one virtual screen — an Xvfb display on this server
 * (Quinn :11, Scout :12, Forge :13, Ledger :14, Brief :15, anything else
 * :19; see botScreen() in agent/browsertools.ts). Screenshots and browsing
 * run on those local displays; there is no VNC and no remote desktop.
 *
 * The `computers` / `screens` tables are kept for compatibility, but their
 * contents are no longer authoritative: status is derived here, screens are
 * derived from the bots in the database. A stale row left by the old Orgo
 * check (status='error', error='Orgo GET /workspaces: ...') is corrected
 * the first time it is read after the upgrade.
 */

const LOCAL_COMPUTER_ID = 'local';

function rowFor(userId: string) {
  let r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId) as any;
  if (!r) {
    db.prepare("INSERT INTO computers(user_id,status,updated_at) VALUES (?, 'running', ?)").run(userId, now());
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  // One-time correction of rows left by the old Orgo status check: a stored
  // Orgo computer id or an Orgo error must never surface in the UI again.
  if (r.orgo_id !== null || r.status === 'error' || (typeof r.error === 'string' && /orgo/i.test(r.error))) {
    db.prepare("UPDATE computers SET status='running', orgo_id=NULL, error=NULL, updated_at=? WHERE user_id=?").run(now(), userId);
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  return r;
}

/** Every non-room bot of this user has one virtual screen, derived from its name. */
function localScreens(userId: string): { botId: string; screenId: string }[] {
  const bots = db.prepare("SELECT id, name FROM bots WHERE user_id=? AND kind<>'room'").all(userId) as any[];
  return bots.map((b) => ({ botId: b.id, screenId: `:${botScreen({ id: b.id, name: b.name }).display}` }));
}

export function computerState(userId: string): ComputerState {
  rowFor(userId);
  return { status: 'running', orgoId: null, error: null, screens: localScreens(userId) };
}

/** The local computer is awake whenever this server is up — nothing to start. */
export async function ensureComputer(userId: string): Promise<string> {
  rowFor(userId);
  return LOCAL_COMPUTER_ID;
}

/** The local computer never sleeps: there is nothing to suspend. Kept so callers don't change. */
export async function suspendComputer(userId: string, _reason = 'manual'): Promise<void> {
  rowFor(userId);
  console.log(`[computer] suspend ignored user=${userId}: the local computer never sleeps`);
}

/** Refresh status from the local machine (no network call). */
export async function refreshComputer(userId: string): Promise<ComputerState> {
  const state = computerState(userId);
  hub.emit(userId, { type: 'computer', state });
  return state;
}

/** This bot's screen on the local computer: its own Xvfb display. */
export function screenFor(_userId: string, botId: string): { computerId: string; screenId: string } {
  const bot = getBotRow(botId);
  const screen = botScreen({ id: botId, name: bot?.name ?? 'bot' });
  return { computerId: LOCAL_COMPUTER_ID, screenId: `:${screen.display}` };
}
