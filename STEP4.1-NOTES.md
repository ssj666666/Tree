# Tree Step 4.1 — frontend push-to-talk + bot voice knowledge

Date: 2026-11-16. Status: **built and verified on the dev VM (no-key + fake-key tests). NOT committed, NOT pushed, NOT deployed. Real-key end-to-end test still to do on the server.**

## What was broken (user-reported, server already on step 4)

1. The voice-chat button still spoke the old xAI realtime WebSocket protocol — the panel said "Voice chat is not available yet".
2. Quinn, asked in text to speak, wrongly claimed it has no voice/TTS and suggested installing espeak-ng — its system prompt had no voice-capability info.
3. The settings panel still showed the stale xAI voice name 'luna'.

## What changed

### 1. Push-to-talk — new `web/src/voice/talk.ts` (+ Composer + panel wiring)
- New module-level controller `useTalkControls(bot, onError)` + zustand store `useTalk` (`idle | recording | waiting | playing`, scoped per bot). Press-and-hold the waveform button (or tap to keep recording, tap again to send; Esc cancels; 120 s cap) → MediaRecorder (webm/opus, reusing `pickMime` from dictation.ts, now exported) → `POST /api/voice/talk` (new `voiceApi.talk()` in `web/src/voice/api.ts`) → the returned mp3 (`audioBase64`) plays via a new `playMp3Base64()` helper in `web/src/voice/audio.ts` (plain `<audio>` element; `started` rejects on autoplay block, `done` resolves on end/error/stop). After `/talk` returns, `loadRows(botId)` refreshes the chat so the transcript + reply text appear (SSE usually delivers them first).
- Composer (`web/src/components/Composer.tsx`): the waveform CTA (shown when the input is empty) is now the talk button — idle shows it, `recording`/`waiting`/`playing` switch it to a dedicated state button (red + breathe animation, see `web/src/styles/voice.css`). Tap while the reply is playing stops playback. Send/stop/in-call buttons unchanged.
- Settings panel (`web/src/components/VoiceSettings.tsx`): the "Voice chat is not available yet" row is now a working hold-to-talk button with the same controller and status labels (Recording… / Thinking… / Speaking… tap to stop).
- The old realtime `VoiceCall` class + `VoiceCallBar` in `web/src/voice/call.ts` are left in place (dead — `startCall` is never called from the UI) for a later cleanup; they are not used by the new flow. `POST /api/voice/session` still returns 503 `voice_call_not_supported`.
- The mic **dictation** button is now enabled too (it was `disabled` since step 1 even though `/stt` works — see "Open question" below). Its recording logic is untouched.

### 2. Per-message TTS — speaker button on assistant messages
- `web/src/components/Transcript.tsx`: assistant bubbles get a small speaker button (`voice_b` icon, next to the timestamp, `.bubble__speak` in `web/src/styles/chat.css`) that calls `POST /api/voice/preview` with that message's text and plays the returned PCM through the existing `PcmPlayer` (via `previewVoice`, now with an optional `text` param). Tap again while playing stops it. Errors show as a red icon + the server's Chinese message in the title.
- `web/src/voice/call.ts`: `previewVoice` now stops any previous preview first (exported `stopPreview()`), so two messages can't talk over each other.
- `server/src/voice.ts`: `/preview` now strips Markdown before synthesis (reuses `stripMarkdownForSpeech`), so a message full of lists/links doesn't get read out as punctuation.

### 3. Bot voice knowledge — `server/src/agent/prompt.ts`
- New "语音（Voice — 你会说话）" section after "## How you work", before the team rules (applies to all bots): the bot CAN speak (user voice arrives as text via ASR, its text replies are spoken back via CosyVoice, default voice 龙应桃）; it must NEVER claim it has no voice/TTS; NEVER suggest installing espeak/festival/pico2wave or any local TTS engine; NEVER mention Orgo/xAI voice; keep spoken replies short and conversational, no lists/Markdown.

### 4. Voice selector — CosyVoice everywhere
- `web/src/components/VoiceSettings.tsx`: fallback list is now the 8 CosyVoice voices from `GET /api/voice/options` (same names as the server list); the Preview button works (plays through `previewVoice`, shows "Playing…" while speaking, tap to stop). If a bot's stored voice is not in the list (e.g. the old xAI 'luna'), the panel shows and selects the server default `longyingtao_v3` instead of the stale name, and a one-time migration PATCH saves that default for the bot. Saving any voice persists a CosyVoice voice id.
- Root cause also fixed at the source: new bots were still created with voice `'luna'` — `server/src/db.ts` (column default) and `server/src/store.ts` (fallback) now default to `'longyingtao_v3'`. Existing bots keep their stored voice until the panel migration (above) or the user picks one.
- `web/src/voice/api.ts`: `VoiceOptions` now carries the server's `configured`/`model`/`voice` fields; `transcribe()`/`preview()` now surface the server's Chinese `message` instead of the short error code or a generic English string (so a missing key shows "语音还没有配置…" in the composer/panel error area).

## Verification (dev VM, 2026-11-16)

- `npm run typecheck` ✅ (server + web), `npm run build` ✅. Built web bundle contains `/api/voice/talk` and `longyingtao_v3`; built `server/dist/agent/prompt.js` contains the CosyVoice voice section.
- **No-key test** (throwaway copy in /tmp, port 8798, fake `DEEPSEEK_API_KEY` for boot only, `DASHSCOPE_API_KEY` unset, real `.env`/`data/` untouched): `/api/health` ok; dev login ok; `/options` returns the 8 voices with `configured: false`; `/stt`, `/preview`, `/talk` all return 503 `voice_not_configured` with the Chinese setup message; `/session` still 503 `voice_call_not_supported`; unauthenticated `/options` returns 401; server stays alive.
- **Fake-key test** (`DASHSCOPE_API_KEY=sk-fake-...`, no workspace ID → fallback domain): `/options` returns `configured: true`; `/stt` → 502 `stt_failed` "语音识别失败：HTTP 401"; `/preview` → 502 `tts_failed` "语音合成失败：Invalid API-key provided."; `/talk` → 502 at STT, before the agent loop. The 401s prove both request shapes reach DashScope's real endpoints and are rejected only on auth. Server stays alive; no crash.
- **Fresh-DB check:** with the new defaults, a new database creates Quinn + Scout with voice `longyingtao_v3` (previously `'luna'`).
- Test server stopped afterwards; /tmp test files deleted; real `.env` and `data/` untouched. **No real-key test was done (no Bailian key available to this agent). No browser click-through was done (no browser session on the dev VM) — the frontend states are code-verified only.**

## How to test on the server (real key, after deploy)

Deploy is the normal flow: push this change, re-run deploy.sh (pinned commit), `systemctl restart tree`, health check. No `.env` changes needed (all new env has working defaults).

1. Open Tree in the browser, log in. Settings panel (right side) → Voice: the voice should read 龙应桃 (not 'luna'). If an old bot still shows 'luna', open the panel once — the migration saves the default automatically.
2. Click **Preview** in the panel — should speak the default greeting as 龙应桃. Tap again to stop.
3. **Dictation:** hold the mic button in the composer, say a sentence, release — the text should appear in the input (needs HTTPS or localhost for the mic; on plain `http://59.110.24.80:8787` use the `chrome://flags` insecure-origins workaround from step 4, or HTTPS later).
4. **Push-to-talk:** hold the waveform button (empty input), say "你好，你是谁", release — Quinn should answer by voice and the transcript + reply should appear in the chat. Tap the button while it's speaking to stop playback.
5. **Per-message TTS:** type "用你的声音说一声你好", send, then click the speaker icon on Quinn's reply — it should read that message aloud.
6. **Bot knowledge:** type "你会说话吗？" — Quinn should say yes and explain (no espeak suggestions, no "我没有语音").
7. Change the voice in the panel (e.g. 龙应沐）, click Preview — the voice should change, and the choice should survive a page refresh.

## Known limits / open questions

- **No full-duplex realtime calls yet** — the call button still isn't a live phone call; push-to-talk is request/response (~5–15 s per round trip, same as step 4). `/session` still returns 503.
- **Dictation mystery (unresolved, not blocking):** the user's screenshots show dictation toasts (`stt_failed`) from the Composer error div, which can only come from `useDictation` — yet the mic button has been `disabled` since the very first Tree commit `d733bee` (verified via `git log -S`), and the built bundle contains "Dictation is not available yet". How the user triggered dictation on the deployed server is unexplained (stale cached bundle is the only hypothesis, unproven). **Decision made in this step:** enable the mic button as part of 4.1 — it exposes already-working, verified code (`/stt` passed the real-key test in step 4), and the user demonstrably expects dictation to work. If the parent disagrees, the revert is one line (`disabled` + the old title in `Composer.tsx`).
- The panel's talk button and the composer's talk button share one controller: starting a recording in one place while the other is recording is blocked (status is shared); closing the settings panel mid-recording cancels the recording (unmount cleanup).
- The old realtime `VoiceCall` class + `VoiceCallBar` remain in the bundle as dead code — a later cleanup can delete them (and `voice/call.ts`'s `useVoice` store) once the new flow is confirmed on the server.
- Autoplay: the reply mp3 plays right after the user releases the button, which counts as a user gesture in most browsers — if a browser still blocks it, the error message points the user to the per-message speaker button.
- Voice list is the curated 8 from `/options`, not the full official 64 for v3-flash; the panel falls back to the same 8 if `/options` fails.
- `/preview` still caps at the server's 1500 spoken chars; long messages are truncated for speech (the full text still shows in the chat).
