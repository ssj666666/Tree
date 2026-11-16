// Tree step 4: voice via Alibaba Bailian (DashScope) — domestic stack.
// Request/response voice chat (NOT full-duplex realtime yet):
//
//   browser audio (webm/opus) --ASR qwen3-asr-flash--> text
//     --DeepSeek agent loop (the normal text turn)--> reply text
//     --TTS cosyvoice-v3-flash--> mp3 audio back to the browser
//
// Verified against the official Alibaba Cloud docs (2026-11-16):
// - TTS, non-realtime HTTP: POST
//   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
//   Header: Authorization: Bearer <DASHSCOPE_API_KEY>
//   Body: { model, input: { text, voice, format, sample_rate, rate, volume, pitch } }
//   Non-streaming answer: output.audio.url (valid 24h) -> GET the URL for the bytes.
//   format default is mp3; pcm/wav/opus also supported. rate 0.5-2.0.
//   Doc: help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
// - ASR, qwen3-asr-flash: OpenAI-compatible chat completions:
//   POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions
//   Body: { model: "qwen3-asr-flash",
//           messages: [{ role: "user",
//                        content: [{ type: "input_audio",
//                                    input_audio: { data: "<data URI or public URL>" } }] }],
//           asr_options: { language?, enable_itn: false } }
//   Answer: choices[0].message.content = transcript. Max 5 min / 10 MB audio.
//   Supported formats include webm, ogg, opus, mp3, m4a, wav. Mono audio.
//   Doc: alibabacloud.com/help/zh/model-studio/qwen-asr-api-reference
// - Workspace domain: Bailian's Beijing region moved to workspace-specific
//   domains ({WorkspaceId}.cn-beijing.maas.aliyuncs.com); the old shared
//   dashscope.aliyuncs.com domain is the fallback when no workspace ID is set.
//   The workspace ID is the first label of that domain (Bailian console ->
//   业务空间， or the wss URL in the user's own DashScope sample code).
//
// Endpoints (all behind the normal session auth; the /voice sub-app is
// mounted under /api in routes.ts, which already applies requireUser):
//   GET  /api/voice/options  -> { voices, languages, speeds, configured, model, voice }
//   POST /api/voice/stt      -> multipart { file, language? } -> { text }
//   POST /api/voice/preview  -> JSON { botId?, voice?, speed?, language?, text? } -> raw PCM bytes (24 kHz)
//   POST /api/voice/talk     -> multipart { file, botId, voice? } -> { transcript, reply, replySeq,
//                                audioMime, audioBase64, pendingApproval }
//   POST /api/voice/session  -> 503: live realtime calls are not built yet (step 4 is
//                                record-then-reply, not full-duplex)
//   POST /api/voice/tool     -> 503: same reason (only a live call would use it)
//   POST /api/voice/end      -> { ok: true } (no live call exists in step 4; beacons must not error)
//
// Missing DASHSCOPE_API_KEY never crashes the server: every voice endpoint
// answers 503 voice_not_configured with a clear Chinese message, the same
// pattern as web_search in step 2.
import { Hono } from 'hono';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow, getBotRow, listRows } from './store.js';
import { enqueue, runInBotQueue } from './agent/loop.js';
import type { VoiceOption } from './types.js';

export const voiceApi = new Hono<AuthVars>();

// Defense in depth: routes.ts already applies requireUser to /api/*, but the
// voice sub-app must never serve audio or agent turns without a session even
// if it is ever mounted somewhere else.
voiceApi.use('/*', requireUser);

// ---------- config ----------

/** CosyVoice v3-flash system voices (official voice list). Default first. */
export const VOICES: VoiceOption[] = [
  { id: 'longyingtao_v3', name: '龙应桃 · 温柔淡定客服女声', gender: 'female' },
  { id: 'longyingmu_v3', name: '龙应沐 · 优雅知性电话助手', gender: 'female' },
  { id: 'longanwen_v3', name: '龙安温 · 优雅知性女', gender: 'female' },
  { id: 'longanya_v3', name: '龙安雅 · 高雅气质女', gender: 'female' },
  { id: 'longanli_v3', name: '龙安莉 · 利落从容女', gender: 'female' },
  { id: 'longanhuan', name: '龙安欢 · 欢脱元气女', gender: 'female' },
  { id: 'longanyang', name: '龙安洋 · 阳光大男孩', gender: 'male' },
  { id: 'longanlang_v3', name: '龙安朗 · 清爽利落男', gender: 'male' },
];

export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'zh', name: 'Chinese' },
  { code: 'en', name: 'English' },
];
export const SPEEDS = [0.7, 0.85, 1, 1.15, 1.3, 1.5];

const TTS_SAMPLE_RATE = 24000;
/** qwen3-asr-flash caps input at 5 min / 10 MB (base64 inflates ~4/3). */
const MAX_AUDIO_BYTES = 7_000_000;
/** TTS text cap: bounds cost and latency of one spoken reply. */
const MAX_TTS_CHARS = 1500;
/** How long /talk waits for the agent turn before giving up (ms). */
const TALK_TURN_TIMEOUT_MS = 150_000;

export function voiceConfigured(): boolean {
  return env.dashscopeKey.length > 0;
}

function dashscopeBase(): string {
  return env.dashscopeWorkspaceId
    ? `https://${env.dashscopeWorkspaceId}.cn-beijing.maas.aliyuncs.com`
    : 'https://dashscope.aliyuncs.com';
}

function notConfigured() {
  return {
    error: 'voice_not_configured',
    message: '语音还没有配置：在服务器 .env 里设置 DASHSCOPE_API_KEY（阿里云百炼的 API Key），再加 DASHSCOPE_WORKSPACE_ID（业务空间 ID），然后重启 tree 服务。文字聊天不受影响。',
  } as const;
}

/** Best-effort message from a DashScope error body (never includes the key). */
async function dashscopeError(res: Response, what: string): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try {
    const p: any = await res.json();
    if (p?.message) detail = String(p.message).slice(0, 300);
    else if (p?.code) detail = `${p.code} (HTTP ${res.status})`;
  } catch { /* not JSON; keep the status */ }
  return new Error(`${what}失败：${detail}`);
}

// ---------- DashScope clients ----------

/**
 * Transcribe recorded audio with qwen3-asr-flash (OpenAI-compatible chat
 * completions). `mime` is the browser's blob type (audio/webm, audio/ogg,
 * audio/mp4, ...). Returns the transcript text ('' when nothing was heard).
 */
export async function transcribeAudio(buf: Buffer, mime: string, language?: string): Promise<string> {
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new Error(`录音太大了（${(buf.length / 1_000_000).toFixed(1)} MB，超过约 7 MB 上限）。请说短一点再试。`);
  }
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  const asrOptions: Record<string, unknown> = { enable_itn: false };
  const lang = (language ?? '').toLowerCase();
  const supported = new Set(['zh', 'yue', 'en', 'ja', 'de', 'ko', 'ru', 'fr', 'pt', 'ar', 'it', 'es', 'hi', 'id', 'th', 'tr', 'uk', 'vi', 'cs', 'da', 'fil', 'fi', 'is', 'ms', 'no', 'pl', 'sv']);
  if (lang && lang !== 'auto' && supported.has(lang)) asrOptions.language = lang;

  let res: Response;
  try {
    res = await fetch(`${dashscopeBase()}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.dashscopeKey}` },
      body: JSON.stringify({
        model: env.asrModel,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
        asr_options: asrOptions,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: any) {
    throw new Error(`语音识别失败（网络错误：${e?.message ?? e}）。`);
  }
  if (!res.ok) throw await dashscopeError(res, '语音识别');
  let payload: any;
  try { payload = await res.json(); } catch { throw new Error('语音识别失败：百炼返回了无法读取的结果。'); }
  return String(payload?.choices?.[0]?.message?.content ?? '').trim();
}

/** Synthesize text with CosyVoice and return the raw audio bytes. */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; format?: 'mp3' | 'pcm' | 'wav'; rate?: number; language?: string } = {},
): Promise<{ bytes: Buffer; mime: string }> {
  const clean = (text ?? '').trim();
  if (!clean) throw new Error('没有可合成的文本。');
  const voice = opts.voice && VOICES.some((v) => v.id === opts.voice) ? opts.voice : env.ttsVoice;
  const format = opts.format ?? 'mp3';
  const rate = Math.min(Math.max(opts.rate ?? 1, 0.5), 2);
  const input: Record<string, unknown> = {
    text: clean.slice(0, MAX_TTS_CHARS),
    voice,
    format,
    sample_rate: TTS_SAMPLE_RATE,
    rate,
    volume: 50,
    pitch: 1,
  };
  const lang = (opts.language ?? '').toLowerCase();
  if (lang === 'zh' || lang === 'en') input.language_hints = [lang];

  const url = `${dashscopeBase()}/api/v1/services/audio/tts/SpeechSynthesizer`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.dashscopeKey}` },
      body: JSON.stringify({ model: env.ttsModel, input }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
    throw new Error(`语音合成失败（网络错误：${e?.message ?? e}）。`);
  }
  if (!res.ok) throw await dashscopeError(res, '语音合成');
  let payload: any;
  try { payload = await res.json(); } catch { throw new Error('语音合成失败：百炼返回了无法读取的结果。'); }
  const audioUrl = payload?.output?.audio?.url;
  if (!audioUrl) throw new Error('语音合成失败：百炼没有返回音频地址。');
  let audio: Response;
  try {
    audio = await fetch(audioUrl, { signal: AbortSignal.timeout(60_000) });
  } catch (e: any) {
    throw new Error(`语音合成失败（下载音频时网络错误：${e?.message ?? e}）。`);
  }
  if (!audio.ok) throw new Error(`语音合成失败：下载音频时百炼返回 HTTP ${audio.status}。`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (!bytes.length) throw new Error('语音合成失败：下载到的音频是空的。');
  return { bytes, mime: format === 'pcm' ? 'application/octet-stream' : format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
}

// ---------- helpers ----------

function clampSpeed(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0.5), 2) : fallback;
}

/** Pick the voice: explicit request > the bot's saved voice > env default. */
function resolveVoice(botRow: any, requested?: unknown): string {
  const known = new Set(VOICES.map((v) => v.id));
  if (typeof requested === 'string' && known.has(requested)) return requested;
  if (botRow?.voice && known.has(botRow.voice)) return botRow.voice;
  return env.ttsVoice;
}

/** Strip Markdown so the bot doesn't read formatting marks out loud. */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
}

/** MIME type to send to ASR for a browser-recorded blob. */
function asrMime(file: File): string {
  const m = (file.type || '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('audio/') || m.startsWith('video/')) return m;
  const name = file.name.toLowerCase();
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.m4a') || name.endsWith('.mp4')) return 'audio/mp4';
  if (name.endsWith('.ogg') || name.endsWith('.opus')) return 'audio/ogg';
  return 'audio/webm';
}

async function readAudioFile(form: FormData): Promise<{ buf: Buffer; mime: string }> {
  const file = form.get('file');
  if (!file || typeof file !== 'object' || !('arrayBuffer' in (file as any))) {
    throw Object.assign(new Error('没有收到录音文件。'), { status: 400 });
  }
  const f = file as File;
  const buf = Buffer.from(await f.arrayBuffer());
  if (!buf.length) throw Object.assign(new Error('录音是空的，请重新录一段。'), { status: 400 });
  return { buf, mime: asrMime(f) };
}

/** Latest assistant message row after `afterSeq` (the turn's reply), if any. */
function latestAssistantText(botId: string, afterSeq: number): { text: string; seq: number } | null {
  const rows = listRows(botId, { limit: 60 });
  let best: { text: string; seq: number } | null = null;
  for (const r of rows) {
    if (r.seq <= afterSeq) continue;
    if (r.body.type === 'message' && r.body.role === 'assistant' && r.body.text?.trim()) {
      best = { text: r.body.text, seq: r.seq };
    }
  }
  return best;
}

/** True when the turn paused for an approval card the user must answer in chat. */
function hasPendingApproval(botId: string, afterSeq: number): boolean {
  return listRows(botId, { limit: 60 }).some(
    (r) => r.seq > afterSeq && r.body.type === 'card' && r.body.card === 'approval' && r.body.status === 'pending',
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------- routes ----------

/** Voice list for the settings panel (works even without a key). */
voiceApi.get('/options', (c) =>
  c.json({
    voices: VOICES,
    languages: LANGUAGES,
    speeds: SPEEDS,
    configured: voiceConfigured(),
    model: env.ttsModel,
    voice: env.ttsVoice,
  }),
);

/** Dictation: transcribe one recording, return the text. */
voiceApi.post('/stt', async (c) => {
  if (!voiceConfigured()) return c.json(notConfigured(), 503);
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: 'bad_request', message: '请求格式不对：请用 multipart 表单上传录音文件。' }, 400); }
  let audio: { buf: Buffer; mime: string };
  try { audio = await readAudioFile(form); } catch (e: any) { return c.json({ error: 'bad_request', message: e?.message ?? '录音读取失败。' }, e?.status ?? 400); }
  const language = typeof form.get('language') === 'string' ? (form.get('language') as string) : undefined;
  try {
    const text = await transcribeAudio(audio.buf, audio.mime, language);
    return c.json({ text });
  } catch (e: any) {
    console.warn('[voice] stt failed', e?.message ?? e);
    return c.json({ error: 'stt_failed', message: e?.message ?? '语音识别失败。' }, 502);
  }
});

/** Voice preview (settings panel): TTS a short line, return raw 24 kHz PCM. */
voiceApi.post('/preview', async (c) => {
  if (!voiceConfigured()) return c.json(notConfigured(), 503);
  const p = await c.req.json<{ botId?: string; voice?: string; speed?: number; language?: string; text?: string }>().catch(() => ({} as any));
  const botRow = p.botId ? getBotRow(p.botId) : null;
  const text = stripMarkdownForSpeech((p.text ?? '').trim()) || '你好，我是 Quinn，有什么可以帮你？';
  try {
    const { bytes } = await synthesizeSpeech(text, {
      voice: resolveVoice(botRow, p.voice),
      format: 'pcm',
      rate: clampSpeed(p.speed, botRow ? clampSpeed(botRow.voice_speed, 1) : 1),
      language: p.language ?? botRow?.voice_language,
    });
    return c.body(bytes, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  } catch (e: any) {
    console.warn('[voice] preview failed', e?.message ?? e);
    return c.json({ error: 'tts_failed', message: e?.message ?? '语音合成失败。' }, 502);
  }
});

/**
 * Voice chat round trip: audio in -> transcript -> normal agent turn -> spoken reply.
 * The turn runs through the bot's usual serial queue (tools, rules, memory all
 * apply), so the reply is the same one the bot would give in text.
 */
voiceApi.post('/talk', async (c) => {
  const user = c.get('user');
  if (!voiceConfigured()) return c.json(notConfigured(), 503);
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: 'bad_request', message: '请求格式不对：请用 multipart 表单上传录音文件。' }, 400); }
  const botId = typeof form.get('botId') === 'string' ? (form.get('botId') as string) : '';
  const botRow = botId ? getBotRow(botId) : null;
  if (!botRow || botRow.user_id !== user.id) return c.json({ error: 'not found', message: '找不到这个 Bot。' }, 404);
  if (botRow.kind === 'room') return c.json({ error: 'not_supported', message: '群聊还不支持语音对话，请先和单个 Bot 说话。' }, 400);
  let audio: { buf: Buffer; mime: string };
  try { audio = await readAudioFile(form); } catch (e: any) { return c.json({ error: 'bad_request', message: e?.message ?? '录音读取失败。' }, e?.status ?? 400); }
  const language = typeof form.get('language') === 'string' ? (form.get('language') as string) : botRow.voice_language;

  // 1. Speech -> text.
  let transcript: string;
  try {
    transcript = await transcribeAudio(audio.buf, audio.mime, language);
  } catch (e: any) {
    console.warn('[voice] talk stt failed', e?.message ?? e);
    return c.json({ error: 'stt_failed', message: e?.message ?? '语音识别失败。' }, 502);
  }
  if (!transcript) {
    // Nothing heard: still answer by voice so the user knows what happened.
    const reply = '我没有听清，你再说一遍好吗？';
    try {
      const { bytes } = await synthesizeSpeech(reply, { voice: resolveVoice(botRow, form.get('voice')), format: 'mp3', rate: clampSpeed(botRow.voice_speed, 1), language: botRow.voice_language });
      return c.json({ transcript: '', reply, replySeq: null, audioMime: 'audio/mpeg', audioBase64: bytes.toString('base64'), pendingApproval: false });
    } catch (e: any) {
      return c.json({ error: 'tts_failed', message: e?.message ?? '语音合成失败。' }, 502);
    }
  }

  // 2. Normal agent turn, through the bot's serial queue. The user message
  //    goes into the chat transcript; the model also gets a short hint that
  //    this is a voice turn and the reply should be brief and spoken-style.
  const userRow = appendRow(botId, 'message', {
    type: 'message',
    role: 'user',
    text: transcript,
    from: { kind: 'voice', id: botId, name: '语音' },
  });
  enqueue(botId, {
    type: 'user',
    text: `${transcript}\n\n（这是一条语音消息：请用口语化、简短的方式回答，不超过三句话，不要使用列表或 Markdown 格式。）`,
  });
  try {
    await withTimeout(runInBotQueue(botId, async () => {}), TALK_TURN_TIMEOUT_MS);
  } catch {
    return c.json({ error: 'voice_reply_timeout', message: '我想得有点久，超时了——回复会继续出现在聊天里，你可以在那里接着看。' }, 504);
  }

  // 3. Read the turn's reply (or notice that it needs the user in chat).
  let reply: string;
  let replySeq: number | null = null;
  let pendingApproval = false;
  const found = latestAssistantText(botId, userRow.seq);
  if (found) {
    reply = found.text;
    replySeq = found.seq;
  } else if (hasPendingApproval(botId, userRow.seq)) {
    pendingApproval = true;
    reply = '这个问题需要你在聊天里确认一下，我已经把请求发过去了。';
  } else {
    const notice = listRows(botId, { limit: 20 }).find((r) => r.seq > userRow.seq && r.body.type === 'notice');
    reply = notice?.body.type === 'notice' ? notice.body.text : '我刚才走神了，没有回上话，你再说一遍好吗？';
  }

  // 4. Text -> speech (mp3, so the browser can play it directly).
  try {
    const spoken = stripMarkdownForSpeech(reply);
    const { bytes } = await synthesizeSpeech(spoken, {
      voice: resolveVoice(botRow, form.get('voice')),
      format: 'mp3',
      rate: clampSpeed(botRow.voice_speed, 1),
      language: botRow.voice_language,
    });
    return c.json({ transcript, reply, replySeq, audioMime: 'audio/mpeg', audioBase64: bytes.toString('base64'), pendingApproval });
  } catch (e: any) {
    console.warn('[voice] talk tts failed', e?.message ?? e);
    return c.json({ error: 'tts_failed', message: e?.message ?? '语音合成失败。' }, 502);
  }
});

// ---------- live realtime calls: not built yet (step 4 is record-then-reply) ----------

voiceApi.post('/session', (c) =>
  c.json({
    error: 'voice_call_not_supported',
    message: '实时语音通话还没接好：Step 4 只支持录音对话（按住说话，听筒回复）和语音试听。实时通话需要下一步的 WebSocket 实时链路。',
  }, 503),
);

voiceApi.post('/tool', (c) =>
  c.json({
    error: 'voice_call_not_supported',
    message: '实时语音通话还没接好，没有进行中的通话可以转交任务。',
  }, 503),
);

/** End of call: nothing to persist in step 4 (no live call exists). */
voiceApi.post('/end', (c) => c.json({ ok: true }));

voiceApi.all('*', (c) => c.json({ error: 'not_found', message: '没有这个语音接口。' }, 404));
