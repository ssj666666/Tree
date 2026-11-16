# Tree Step 4 — Voice (Bailian ASR → DeepSeek → CosyVoice TTS)

Date: 2026-11-16. Status: **built and verified on the dev VM (no-key + fake-key tests). NOT deployed, NOT committed, NOT pushed. Real-key end-to-end test still to do on the server.**

## What was built

Request/response voice chat (NOT full-duplex realtime). The old xAI realtime
stub (`server/src/voice.ts`, every `/api/voice/*` → 503) is replaced with a
domestic Bailian stack:

```
browser audio (webm/opus) --ASR qwen3-asr-flash--> transcript
  --normal DeepSeek agent loop (same text turn: tools, rules, memory)--> reply text
  --TTS cosyvoice-v3-flash--> mp3 back to the browser
```

### API facts (verified from official Alibaba Cloud docs 2026-11-16, not guessed)

- **TTS** — CosyVoice non-realtime HTTP:
  `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
  Header `Authorization: Bearer <DASHSCOPE_API_KEY>`.
  Body `{ model, input: { text, voice, format, sample_rate, rate, volume, pitch } }`.
  Non-streaming answer: `output.audio.url` (valid 24h) → GET the URL for bytes.
  `format` default is **mp3** (pcm/wav/opus also supported); `rate` 0.5–2.0.
  Doc: https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
- **ASR** — qwen3-asr-flash, OpenAI-compatible chat completions:
  `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`
  Body `{ model: "qwen3-asr-flash", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "<data URI>" } }] }], asr_options: { language?, enable_itn: false } }`.
  Answer: `choices[0].message.content` = transcript. Max 5 min / 10 MB audio.
  Supported formats include webm, ogg, opus, mp3, m4a, wav. Mono audio.
  Doc: https://www.alibabacloud.com/help/zh/model-studio/qwen-asr-api-reference
- **Workspace domain**: Bailian Beijing moved to workspace-specific domains
  (`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`); the old shared
  `dashscope.aliyuncs.com` is the fallback when no workspace ID is set.
  The workspace ID is the first label of that domain (Bailian console →
  业务空间， or the `wss://<id>.cn-beijing.maas.aliyuncs.com/...` URL in the
  user's own DashScope sample code).
- **NOT used**: the OpenAI-compatible `/audio/speech` and `/audio/transcriptions`
  paths — DashScope's compatible-mode only exposes chat/completions and
  embeddings for these models; TTS/ASR are native endpoints (confirmed by a
  third-party skill doc and by the ASR doc's two access modes).
- **Voice IDs are model-version-locked**: `longyingtao_v3` etc. only work on
  `cosyvoice-v3-*`. The user's old voice `longanfengyue` belonged to
  qwen-audio-3.0-tts-flash (a different model family) and is not reused.

### Files changed (3)

- `server/src/voice.ts` — full rewrite (was the step-1 stub). Exports
  `voiceApi`, `VOICES`, `LANGUAGES`, `SPEEDS`, `voiceConfigured()`,
  `transcribeAudio()`, `synthesizeSpeech()`.
- `server/src/env.ts` — added `dashscopeKey` (DASHSCOPE_API_KEY),
  `dashscopeWorkspaceId` (DASHSCOPE_WORKSPACE_ID), `ttsModel`
  (TREE_TTS_MODEL, default `cosyvoice-v3-flash`), `ttsVoice`
  (TREE_TTS_VOICE, default `longyingtao_v3`), `asrModel`
  (TREE_ASR_MODEL, default `qwen3-asr-flash`).
- `.env.example` — Step 4 section with placeholders only (no real values).

No other files changed. `.env` and `data/` were NOT touched.

### Endpoints (all behind the normal session auth)

| Route | Input | Output |
|---|---|---|
| `GET /api/voice/options` | — | `{ voices[8], languages, speeds, configured, model, voice }`. Works without a key (`configured: false`). |
| `POST /api/voice/stt` | multipart `file` (+`language?`) | `{ text }`. Frontend dictation already calls this. |
| `POST /api/voice/preview` | JSON `{ botId?, voice?, speed?, language?, text? }` | Raw 24 kHz PCM bytes (`application/octet-stream`) — exactly what the settings panel's `PcmPlayer` expects. |
| `POST /api/voice/talk` | multipart `file`, `botId` (+`voice?`, `language?`) | `{ transcript, reply, replySeq, audioMime: "audio/mpeg", audioBase64, pendingApproval }` |
| `POST /api/voice/session` | — | 503 `voice_call_not_supported` (live realtime calls not built yet) |
| `POST /api/voice/tool` | — | 503 `voice_call_not_supported` |
| `POST /api/voice/end` | — | `{ ok: true }` (beacon-safe; no live call exists in step 4) |

`/talk` flow in detail:
1. ASR the uploaded audio (max ~7 MB raw, i.e. under the 10 MB base64 cap).
2. Empty transcript → spoken "我没有听清，你再说一遍好吗？" (still returns audio).
3. Otherwise append the transcript as a user message row (marked
   `from: { kind: 'voice' }`), then `enqueue()` a normal text turn with a
   short hint appended ("口语化、简短回答，不超过三句话，不要列表/Markdown").
   The hint goes to the model's history only, not the visible chat row.
4. Wait for the turn via `runInBotQueue()` (150 s cap). The turn runs through
   the bot's serial queue, so tools/rules/memory all apply.
5. Read the latest assistant message after the user row. If the turn paused
   for an approval card, reply is a spoken "需要你在聊天里确认一下" and
   `pendingApproval: true`. If the turn errored, the notice text is used.
6. TTS the reply (Markdown stripped, capped at 1500 chars) as mp3.
   Timeout waiting for the turn → 504 `voice_reply_timeout` (the reply still
   lands in chat afterwards).

Voice resolution: explicit request voice → the bot's saved `voice` setting
(if it is one of the 8 CosyVoice voices) → `TREE_TTS_VOICE`. The old stored
default `'luna'` (an xAI voice) is never sent to DashScope. Speed comes from
the bot's `voiceSpeed` (0.7–1.5) mapped to CosyVoice `rate`; `language_hints`
is passed only for `zh`/`en`.

## Verification (dev VM, 2026-11-16)

- `npm run typecheck` ✅, `npm run build` ✅.
- **No-key test** (server on port 8799, throwaway DB in /tmp, fake
  `DEEPSEEK_API_KEY` for boot only, `DASHSCOPE_API_KEY` unset, real `.env`
  never loaded): `/api/health` ok; dev login ok; `/options` returns the 8
  voices with `configured: false`; `/stt`, `/preview`, `/talk` all return
  503 `voice_not_configured` with the Chinese setup message; `/session`
  returns 503 `voice_call_not_supported`; `/end` returns `{ok:true}`;
  unauthenticated `/options` returns 401; server stays alive afterwards.
- **Fake-key test** (`DASHSCOPE_API_KEY=sk-fake-...`, no workspace ID →
  fallback domain): `/options` returns `configured: true`;
  `/stt` → 502 `stt_failed` "语音识别失败：HTTP 401";
  `/preview` → 502 `tts_failed` "语音合成失败：Invalid API-key provided.";
  `/talk` → 502 at STT, before the agent loop. The 401s prove both request
  shapes reach DashScope's real endpoints and are rejected only on auth —
  the URLs, headers and bodies are correct. Server stays alive; no crash.
- Test server stopped afterwards; /tmp test files deleted; real `.env` and
  `data/` untouched. **No real-key test was done (no Bailian key available
  to this agent).**

## How to test on the server (real key)

In `/root/tree/.env` add (values from the user's Bailian console):

```
DASHSCOPE_API_KEY=sk-...            # Bailian console -> API Key
DASHSCOPE_WORKSPACE_ID=<id>         # first label of {id}.cn-beijing.maas.aliyuncs.com (console -> 业务空间）
TREE_TTS_MODEL=cosyvoice-v3-flash
TREE_TTS_VOICE=longyingtao_v3
TREE_ASR_MODEL=qwen3-asr-flash
```

Then re-run deploy.sh (picks up the new code), `systemctl restart tree`,
and test in this order:
1. `curl -s http://localhost:8787/api/health` → `{"ok":true,...}`.
2. In the Tree web UI, open Quinn → voice settings → Preview: should play
   "你好，我是 Quinn…" in 龙应桃's voice.
3. Hold the mic button in the composer, say a short Chinese sentence,
   release: the transcript should appear in the composer box.
4. Ask Quinn by voice (needs the frontend piece below, or test `/talk`
   directly with curl + a recorded webm file) and check the mp3 reply.
5. If `/stt` returns 502 with a DashScope message, read the message: 401 =
   wrong key, 403 = workspace/region mismatch (check the workspace ID and
   that the key is a Beijing-region key), 429 = rate limit.

## Known limits / what is NOT done

- **No full-duplex realtime calls yet.** The call button in the UI talks to
  the old xAI realtime WebSocket protocol (`/session` → `websocketUrl` +
  `clientSecret`, `session.update`, `input_audio_buffer.append`,
  `response.create` …). Step 4 deliberately returns 503 for `/session` and
  `/tool`. The frontend still needs a push-to-talk flow: record → POST
  `/api/voice/talk` → play the returned mp3. That is the next frontend task.
- **No phone calls.** Real phone numbers still need the Alibaba voice number
  approval (clinic business licence) — out of scope for step 4.
- **Latency**: one `/talk` round trip = ASR (~1–3 s) + DeepSeek turn
  (depends on tools; a plain reply is a few seconds) + TTS (~1–3 s) +
  audio download. Expect roughly 5–15 s per exchange; not conversational
  realtime. Streaming TTS (SSE) and streaming ASR would cut this later.
- **ASR format**: browser webm/opus is passed through as-is; DashScope
  lists webm as supported, but the first real-key test should confirm a
  real browser recording transcribes (MediaRecorder webm without a duration
  header has tripped other providers; DashScope's own docs do not flag it).
- **Long replies**: TTS is capped at 1500 chars; the returned `reply` text
  is the full text, only the spoken audio is truncated.
- **Cost**: TTS cosyvoice-v3-flash ¥1/万字符 (Beijing); ASR qwen3-asr-flash
  ~¥0.79–1.1/小时. A 2-minute call with ~250 spoken chars costs roughly
  ¥0.03–0.05 in voice fees (model + ASR time).
- **Voice list is curated, not exhaustive**: 8 voices in `/options`. The
  full official list has 64 for v3-flash; add more IDs to `VOICES` in
  `server/src/voice.ts` if the user wants them (any `_v3` ID works on
  `cosyvoice-v3-flash`; `longanhuan`/`longanyang` have no `_v3` suffix).
- **No voice cloning / custom voices** in step 4 (system voices only).
  Cloned/designed voices would need a voice ID from the Bailian console
  passed as `TREE_TTS_VOICE`.
