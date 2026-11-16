# Tree Step 6 — Email, Layer 2 (code)

Date: 2026-11-16 (night). Status: **built and verified on the dev VM with the
real DeepSeek key. NOT deployed yet — one deploy picks up step 4.2 + step 5 +
step 6 together. Real-mailbox end-to-end test still needs Layer 1 (below).**

This is the code half of the email work. It makes Quinn an inbox manager in
the Dan Martell sense — read, sort, draft in your voice — but sending stays
in "review mode" (draft first, you approve, then it sends).

## What was built

### 1. `server/src/agent/emailtools.ts` (new)
One mailbox over standard IMAP/SMTP. Four functions:
- `readInbox(limit)` — newest N mails: uid, from, subject, date, seen,
  200-char snippet. Parses with `mailparser`.
- `readEmail(uid)` — full text (capped 8000 chars) + attachment names.
- `draftEmail(userId, botId, to, subject, body)` — creates a draft row,
  does NOT send. Validates the address, rejects empty subject/body and
  bodies over 20000 chars.
- `sendEmail(userId, draftId)` — sends a draft, once. Only drafts in
  status `draft` can be sent; re-sending returns "已经发出去了，不要重复发".
- `buildMail(draft)` — the nodemailer message options (shared by send +
  tests). Every send is appended to `data/email-sends.log`.
- Every function returns a short Chinese message on failure and never
  throws. Connect/send timeouts are 10–20s so a dead server can't hang
  the agent loop.

### 2. `server/src/agent/tools.ts` — 4 new tools
`read_inbox`, `read_email`, `draft_email`, `send_email`. All bots share
them (same as every other tool); the inbox-manager role is Quinn's job.

### 3. `server/src/env.ts` + `.env.example` — config
`TREE_EMAIL_IMAP_HOST` (default port 993), `TREE_EMAIL_IMAP_PORT`,
`TREE_EMAIL_USER`, `TREE_EMAIL_PASS`, `TREE_EMAIL_SMTP_HOST` (default
port 465), `TREE_EMAIL_SMTP_PORT`, `TREE_EMAIL_FROM`. All empty = the
email tools answer "邮箱还没配置" in Chinese; everything else still works.

### 4. `server/src/db.ts` — `email_drafts` table
id, user_id, bot_id, to_addr, subject, body, status (draft/sent),
message_id, created_at, sent_at. Foreign keys to users/bots.

### 5. `server/src/agent/prompt.ts` — email section
Quinn's system prompt now says: draft first, show the full draft to the
user, send only after the user explicitly says so; never skip the draft,
never mail customers/strangers on her own; the 6am inbox整理 runs in
"只起草不发送" review mode for the first few weeks.

### 6. Deps (server/package.json + package-lock.json)
`nodemailer@10.6.0`, `imapflow@2.12.1`, `mailparser@3.14.5`.

## Verification (VM, 2026-11-16 night)
- `npm run typecheck -w server` ✓, `npm run build -w server` ✓.
- **Unconfigured:** `readInbox` / `readEmail` return the "邮箱还没配置"
  message; `sendEmail` refuses; the draft stays `draft` in the DB.
- **Bad config** (IMAP 127.0.0.1:1993): graceful failure in 8ms —
  `读收件箱失败：connect ECONNREFUSED…（检查 .env 里的邮箱地址、密码和服务器设置是否正确。）`
- **MIME round-trip:** nodemailer streamTransport builds the message;
  mailparser parses it back — subject `周末拜访`, to, text all correct
  (Chinese subjects are encoded-word in raw MIME, which is normal).
- **Live Quinn test (real DeepSeek key, port 8793):**
  - "读一下收件箱" → Quinn called `read_inbox`, reported email not
    configured, listed the missing .env items, and offered to start the
    6am digest once configured.
  - "给 test@example.com 写封邮件…" → Quinn called `draft_email`,
    showed the full draft, warned that sending would fail until the
    mailbox is configured, and asked for confirmation. Draft row in DB:
    status `draft`. Nothing was sent.
- Test servers stopped; test DBs removed.

## Known limits (not bugs)
- Plain text only on send; reading shows attachment names but doesn't
  download attachments.
- INBOX only — no folders, labels, or spam handling yet.
- No 6am digest routine yet: create it after Layer 1 ("每天早上 6 点读
 收件箱，分类，按我的语气起草回复，只列出需要我决策的，先只起草不发送").
- No real-mailbox end-to-end test yet — that needs Layer 1 below.

---

# Layer 1 — 域名 + 企业邮箱（用户操作，约 30–60 分钟）

Code is ready; the mailbox itself isn't. Do these in order, then tell me
and I'll test the real thing with Quinn.

## 1. 买一个域名（约 ¥50–60/年）
- 阿里云万网或腾讯云 DNSPod，搜一个你喜欢的名字（比如公司/品牌名），
  买 `.com`。买完要做实名认证（按页面提示传身份证，通常几分钟到几小时）。
- 域名只是个名字：它是你邮箱地址 `@` 后面的部分（比如 `hi@你的域名.com`）。

## 2. 开通腾讯企业邮箱免费版
- 打开 https://work.weixin.qq.com/mail/ ，点“免费开通”，按页面提示走
  （它会先让你注册/登录企业微信）。
- 免费版对试点完全够用（几十个账号、每天可发几百封；开通页面会写当前
  的具体数字）。如果页面要求企业认证而你还没有营业执照，先停下来告
  诉我，我再帮你看别的方案（比如阿里云企业邮箱免费版）。
- 开通后，在管理后台创建一个邮箱账号，比如 `hi@你的域名.com`，设一个
  密码（这个密码只存在你手里，不要发给我）。

## 3. 域名解析（让邮件能寄到你的域名）
在域名服务商的“DNS 解析”里加三条记录（腾讯企业邮给的值，管理后台
的域名设置页也会列出来）：
- MX 记录，主机 `@`，记录值 `mxbiz1.qq.com`，优先级 5
- MX 记录，主机 `@`，记录值 `mxbiz2.qq.com`，优先级 10
- TXT 记录，主机 `@`，记录值 `v=spf1 include:spf.mail.qq.com ~all`
- 生效要几分钟到 24 小时。等不及可以先做第 4 步的服务器配置，收发测
  试等解析生效后再做。

## 4. 服务器 .env 里填 7 行，然后重启
在服务器 `/root/tree/.env` 里加上（密码用你第 2 步设的那个）：
```
TREE_EMAIL_IMAP_HOST=imap.exmail.qq.com
TREE_EMAIL_IMAP_PORT=993
TREE_EMAIL_SMTP_HOST=smtp.exmail.qq.com
TREE_EMAIL_SMTP_PORT=465
TREE_EMAIL_USER=hi@你的域名.com
TREE_EMAIL_PASS=你设的邮箱密码
TREE_EMAIL_FROM=hi@你的域名.com
```
然后 `systemctl restart tree`。注意：.env 是密钥文件，永远不要把它的
内容贴到聊天里。

## 5. 测试
重启后问 Quinn：“读一下收件箱。” 能读出邮件就说明通了。再让她给
你自己的另一个邮箱写封测试信，确认“起草 → 你点头 → 发送”整条链路。
