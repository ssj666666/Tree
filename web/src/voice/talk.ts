// Push-to-talk voice chat (Tree step 4.1).
//
// Replaces the old xAI realtime call flow (voice/call.ts): no WebSocket, no live
// call. Press-and-hold (or tap to keep recording) -> MediaRecorder (webm/opus)
// -> POST /api/voice/talk -> the reply mp3 plays in the browser, and the
// transcript + reply text appear in the chat as normal rows.
// Recording behaviour mirrors dictation.ts (HOLD_MS tap-to-toggle, MAX_MS cap,
// Esc cancels, unmount cancels); a missing DASHSCOPE_API_KEY surfaces as the
// server's Chinese "voice_not_configured" message via onError, never a crash.
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type TalkResult } from './api';
import { micErrorMessage, openMic, playMp3Base64 } from './audio';
import { pickMime } from './dictation';

export type TalkStatus = 'idle' | 'recording' | 'waiting' | 'playing';

interface TalkState { status: TalkStatus; botId: string | null }
export const useTalk = create<TalkState>(() => ({ status: 'idle', botId: null }));
const setT = (p: Partial<TalkState>) => useTalk.setState(p);

const HOLD_MS = 350;
const MAX_MS = 120_000;

interface Session {
  mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; downAt: number;
  cancelled: boolean; timer: ReturnType<typeof setTimeout>;
  botId: string; language?: string; onError: (msg: string) => void;
  toggleMode: boolean;
}
let session: Session | null = null;
let starting = false;
let pendingToggle = false;
let playback: ReturnType<typeof playMp3Base64> | null = null;

function stopPlayback() {
  playback?.stop();
  playback = null;
}

function finish(cancel = false) {
  const s = session;
  if (!s) return;
  s.cancelled = cancel;
  clearTimeout(s.timer);
  if (s.mr.state !== 'inactive') s.mr.stop();
  else s.stream.getTracks().forEach((t) => t.stop());
}

async function sendTalk(s: Session, blob: Blob) {
  setT({ status: 'waiting' });
  let res: TalkResult;
  try {
    res = await voiceApi.talk(blob, s.botId, s.language);
  } catch (e) {
    setT({ status: 'idle', botId: null });
    s.onError((e as Error).message || '语音对话失败');
    return;
  }
  // The server already appended the transcript + reply rows; make sure the
  // chat shows them (SSE usually delivers them first — this is belt-and-braces).
  useStore.getState().loadRows(s.botId).catch(() => {});
  if (!res.audioBase64) { setT({ status: 'idle', botId: null }); return; }
  const p = playMp3Base64(res.audioBase64, res.audioMime || 'audio/mpeg');
  playback = p;
  setT({ status: 'playing' });
  try {
    await p.started;
  } catch {
    p.stop();
    playback = null;
    setT({ status: 'idle', botId: null });
    s.onError('浏览器拦截了自动播放，点一下那条回复旁边的喇叭可以再听一遍。');
    return;
  }
  await p.done;
  if (playback === p) playback = null;
  setT({ status: 'idle', botId: null });
}

async function begin(botId: string, language: string | undefined, onError: (msg: string) => void) {
  if (session || starting || useTalk.getState().status !== 'idle') return;
  if (typeof MediaRecorder === 'undefined') { onError('这个浏览器不支持录音。'); return; }
  starting = true;
  stopPlayback();
  const downAt = Date.now();
  let stream: MediaStream | null = null;
  try {
    stream = await openMic();
    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const s: Session = {
      mr, stream, chunks: [], downAt, cancelled: false,
      timer: setTimeout(() => finish(), MAX_MS),
      botId, language, onError, toggleMode: pendingToggle,
    };
    pendingToggle = false;
    session = s;
    mr.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };
    mr.onstop = () => {
      s.stream.getTracks().forEach((t) => t.stop());
      session = null;
      if (s.cancelled || !s.chunks.length || Date.now() - s.downAt < 250) {
        setT({ status: 'idle', botId: null });
        return;
      }
      const blob = new Blob(s.chunks, { type: mr.mimeType || mime || 'audio/webm' });
      void sendTalk(s, blob);
    };
    mr.start(250);
    setT({ status: 'recording', botId });
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    onError(micErrorMessage(e));
    setT({ status: 'idle', botId: null });
  } finally {
    starting = false;
  }
}

/** Pointer down on a talk button: tap while playing stops the reply. */
export function talkPointerDown(bot: Bot, onError: (msg: string) => void) {
  const st = useTalk.getState();
  if (st.status === 'playing') { stopPlayback(); setT({ status: 'idle', botId: null }); return; }
  if (st.status === 'waiting') return;
  if (session && session.toggleMode) { finish(); return; }
  void begin(bot.id, bot.voiceLanguage, onError);
}

/** Pointer up: quick tap toggles continuous recording, long hold sends on release. */
export function talkPointerUp() {
  const s = session;
  if (!s) {
    if (starting) pendingToggle = true;
    return;
  }
  if (s.toggleMode) return;
  if (Date.now() - s.downAt < HOLD_MS) s.toggleMode = true;
  else finish();
}

/** Enter/Space: tap to start in toggle mode, tap again to send. */
export function talkKeyDown(bot: Bot, onError: (msg: string) => void) {
  if (session) { finish(); return; }
  pendingToggle = true;
  void begin(bot.id, bot.voiceLanguage, onError);
}

/** Shared controller for the composer waveform button and the settings panel. */
export function useTalkControls(bot: Bot, onError: (msg: string) => void) {
  const status = useTalk((s) => (s.botId === bot.id ? s.status : 'idle'));
  const cb = useRef({ bot, onError });
  cb.current = { bot, onError };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const { bot: b, onError: err } = cb.current;
    talkPointerDown(b, err);
  }, []);

  const onPointerUp = useCallback(() => { talkPointerUp(); }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const { bot: b, onError: err } = cb.current;
    talkKeyDown(b, err);
  }, []);

  // Esc cancels an in-progress recording; unmount cancels it too.
  useEffect(() => {
    if (status !== 'recording') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [status]);
  useEffect(() => () => { finish(true); }, []);

  return { status, onPointerDown, onPointerUp, onKeyDown };
}
