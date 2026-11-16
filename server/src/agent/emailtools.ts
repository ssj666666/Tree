import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';

/**
 * Step 6 — email (Layer 2: code). One mailbox over standard IMAP/SMTP
 * (Tencent Exmail: imap.exmail.qq.com:993 / smtp.exmail.qq.com:465).
 *
 * Design (Dan Martell's "review mode" first):
 * - Reading is direct: read_inbox / read_email.
 * - Sending NEVER takes raw text. The bot must first call draft_email,
 *   show the draft to the user, and only call send_email(draft_id) after
 *   the user explicitly says to send it. A draft can only be sent once.
 * - Every function returns a short Chinese message on failure and never
 *   throws (same convention as browsertools).
 * - Every send is appended to data/email-sends.log.
 */

export function emailConfigured(): boolean {
  return Boolean(env.emailImapHost && env.emailImapUser && env.emailImapPass && env.emailSmtpHost);
}

export const EMAIL_NOT_CONFIGURED =
  '邮箱还没配置：需要在服务器 .env 里填 TREE_EMAIL_IMAP_HOST、TREE_EMAIL_USER、TREE_EMAIL_PASS、TREE_EMAIL_SMTP_HOST（域名 + 企业邮箱开好之后，见 EMAIL-NOTES.md），然后重启服务再试。';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}超时（${ms / 1000}秒）`)), ms))]);
}

async function connectImap(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: env.emailImapHost,
    port: env.emailImapPort,
    secure: env.emailImapPort === 993 || env.emailImapPort === 465,
    auth: { user: env.emailImapUser, pass: env.emailImapPass },
    logger: false,
    socketTimeout: 15_000,
  });
  await withTimeout(client.connect(), 12_000, '连接邮箱服务器');
  return client;
}

const snippet = (text: string, n = 200) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** mailparser gives an address object or an array of them; flatten to text. */
const addrText = (v: unknown): string => {
  if (!v) return '';
  if (Array.isArray(v)) return v.map((a: any) => a?.text ?? '').filter(Boolean).join(', ');
  return (v as any)?.text ?? '';
};

/** List the most recent emails in INBOX (newest last). */
export async function readInbox(limit = 10): Promise<string> {
  if (!emailConfigured()) return EMAIL_NOT_CONFIGURED;
  const n = Math.max(1, Math.min(20, Math.floor(limit) || 10));
  let client: ImapFlow | null = null;
  try {
    client = await connectImap();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mbox = client.mailbox;
      if (!mbox) return '收件箱打不开（服务器没有返回邮箱信息）。';
      const total = mbox.exists;
      if (!total) return '收件箱是空的。';
      const from = Math.max(1, total - n + 1);
      const out: any[] = [];
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, source: true })) {
        if (!msg.source) continue;
        const parsed: any = await simpleParser(msg.source);
        out.push({
          uid: msg.uid,
          from: addrText(parsed.from),
          subject: parsed.subject ?? '',
          date: parsed.date?.toISOString() ?? '',
          seen: msg.flags?.has('\\Seen') ?? false,
          snippet: snippet(parsed.text ?? ''),
        });
      }
      return JSON.stringify(out, null, 2);
    } finally {
      lock.release();
    }
  } catch (e: any) {
    return `读收件箱失败：${e?.message ?? e}（检查 .env 里的邮箱地址、密码和服务器设置是否正确。）`;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/** Read one email's full text by uid (from read_inbox). */
export async function readEmail(uid: number): Promise<string> {
  if (!emailConfigured()) return EMAIL_NOT_CONFIGURED;
  if (!Number.isFinite(uid) || uid <= 0) return 'uid 不对：用 read_inbox 返回的 uid 再试。';
  let client: ImapFlow | null = null;
  try {
    client = await connectImap();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let found: any = null;
      for await (const msg of client.fetch(String(uid), { envelope: true, source: true }, { uid: true })) found = msg;
      if (!found) return `找不到 uid=${uid} 的信（可能已被删除或移动）。`;
      if (!found.source) return `uid=${uid} 的信没有正文。`;
      const parsed: any = await simpleParser(found.source);
      const text = (parsed.text ?? '').slice(0, 8000);
      const attachments = (parsed.attachments ?? []).map((a: any) => ({ filename: a.filename ?? '', size: a.size ?? 0 }));
      return JSON.stringify({
        uid,
        from: addrText(parsed.from),
        to: addrText(parsed.to),
        subject: parsed.subject ?? '',
        date: parsed.date?.toISOString() ?? '',
        text,
        attachments,
      }, null, 2);
    } finally {
      lock.release();
    }
  } catch (e: any) {
    return `读信失败：${e?.message ?? e}`;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

export interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
}

/** Create a draft (does NOT send). Returns the draft id for send_email. */
export function draftEmail(userId: string, botId: string, to: string, subject: string, body: string): EmailDraft | { error: string } {
  const toAddr = String(to ?? '').trim();
  const subj = String(subject ?? '').trim();
  const text = String(body ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toAddr)) return { error: `收件地址不对：${toAddr}（要一个完整邮箱地址）。` };
  if (!subj) return { error: '主题不能为空。' };
  if (!text.trim()) return { error: '正文不能为空。' };
  if (text.length > 20000) return { error: '正文太长（超过 20000 字），拆短再起草。' };
  const id = newId('draft');
  try {
    db.prepare('INSERT INTO email_drafts(id,user_id,bot_id,to_addr,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, userId, botId, toAddr, subj, text, 'draft', now());
  } catch (e: any) {
    return { error: `草稿没存上：${e?.message ?? e}` };
  }
  return { id, to: toAddr, subject: subj, body: text };
}

/** Nodemailer mail options for a draft — shared by sendEmail and tests. */
export function buildMail(draft: EmailDraft) {
  return {
    from: env.emailFrom || env.emailImapUser,
    to: draft.to,
    subject: draft.subject,
    text: draft.body,
  };
}

function logSend(draft: EmailDraft, messageId: string) {
  try {
    const dir = path.join(env.workspace, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'email-sends.log'), `${new Date().toISOString()} ${draft.id} to=${draft.to} subject=${draft.subject} messageId=${messageId}\n`);
  } catch { /* logging must never break sending */ }
}

/** Send a draft by id. Only drafts in status 'draft' can be sent, once. */
export async function sendEmail(userId: string, draftId: string): Promise<string> {
  if (!emailConfigured()) return EMAIL_NOT_CONFIGURED;
  const row = db.prepare('SELECT * FROM email_drafts WHERE id=? AND user_id=?').get(String(draftId ?? ''), userId) as any;
  if (!row) return `找不到草稿 ${draftId}（可能不属于你，或已被删除）。`;
  if (row.status !== 'draft') return `这封草稿已经发出去了（状态：${row.status}），不要重复发。`;
  const draft: EmailDraft = { id: row.id, to: row.to_addr, subject: row.subject, body: row.body };
  try {
    const transport = nodemailer.createTransport({
      host: env.emailSmtpHost,
      port: env.emailSmtpPort,
      secure: env.emailSmtpPort === 465,
      auth: { user: env.emailImapUser, pass: env.emailImapPass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    const info = await withTimeout(transport.sendMail(buildMail(draft)), 20_000, '发送邮件');
    db.prepare("UPDATE email_drafts SET status='sent', message_id=?, sent_at=? WHERE id=?").run(String(info.messageId ?? ''), now(), draft.id);
    logSend(draft, String(info.messageId ?? ''));
    return JSON.stringify({ ok: true, to: draft.to, subject: draft.subject, messageId: info.messageId ?? '' });
  } catch (e: any) {
    return `发信失败：${e?.message ?? e}（草稿还在，改好设置后可以再发一次。）`;
  }
}
