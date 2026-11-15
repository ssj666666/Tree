// Tree step 1: voice is DISABLED.
// The original module was entirely xAI-specific (realtime voice agent, TTS voices,
// STT transcription against https://api.x.ai/v1). DeepSeek has no equivalent
// realtime voice service, so the whole voice stack is stubbed out here:
// every /api/voice/* route answers 503 with a clear message, and the text
// chat path never touches this module. Voice comes back in a later step
// via a domestic stack (ASR -> DeepSeek -> TTS).
import { Hono } from 'hono';
import type { AuthVars } from './lib/auth.js';
import type { VoiceOption } from './types.js';

export const voiceApi = new Hono<AuthVars>();

voiceApi.all('*', (c) =>
  c.json({ error: 'voice_disabled', message: 'Voice calls are not available in Tree yet (step 1 is text-only). Voice will be added later with a domestic ASR/TTS stack.' }, 503),
);

// Kept so existing imports keep compiling; the lists are static data only.
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'zh', name: 'Chinese' },
  { code: 'en', name: 'English' },
];
export const SPEEDS = [0.7, 0.85, 1, 1.15, 1.3, 1.5];

export const FALLBACK_VOICES: VoiceOption[] = [];
