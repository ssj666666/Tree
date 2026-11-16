import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { previewVoice, stopPreview } from '../voice/call';
import { useTalkControls } from '../voice/talk';
import { Icon } from './Icon';

/** CosyVoice v3 voices (server step 4) — used until GET /api/voice/options answers. */
const FALLBACK: VoiceOptions = {
  voices: [
    { id: 'longyingtao_v3', name: '龙应桃 · 温柔淡定客服女声', gender: 'female' },
    { id: 'longyingmu_v3', name: '龙应沐 · 优雅知性电话助手', gender: 'female' },
    { id: 'longanwen_v3', name: '龙安温 · 优雅知性女声', gender: 'female' },
    { id: 'longanya_v3', name: '龙安雅 · 高雅气质女声', gender: 'female' },
    { id: 'longanfengyue', name: '龙安风月 · 温润男声', gender: 'male' },
    { id: 'longxiaochun_v3', name: '龙小淳 · 阳光少年男声', gender: 'male' },
    { id: 'longxiaoxia_v3', name: '龙小夏 · 清亮少女女声', gender: 'female' },
    { id: 'longyueyang_v3', name: '龙玥阳 · 沉稳磁性男声', gender: 'male' },
  ],
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'zh', name: 'Chinese' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

function NativeSelect<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="mini-select mini-select--native">
      <span>{current}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot).
 * Step 4.1: voices are CosyVoice (server step 4); preview and push-to-talk work. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [optsLoaded, setOptsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Push-to-talk (step 4.1): hold to speak, Quinn answers by voice.
  const talk = useTalkControls(bot, setError);
  const migrated = useRef(false);

  useEffect(() => { voiceApi.options().then((o) => { setOpts(o); setOptsLoaded(true); }).catch(() => {}); }, []);
  useEffect(() => setError(null), [bot.id]);

  const save = useCallback(async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage } : b)) }));
      setError('Couldn’t save that setting.');
    }
  }, [bot.id]);

  // Effective voice: a stored voice that is not a CosyVoice voice (e.g. the old
  // xAI 'luna') is shown as the server default instead of the stale name.
  const defaultVoice = opts.voice ?? 'longyingtao_v3';
  const effectiveVoice = opts.voices.some((v) => v.id === bot.voice) ? bot.voice : defaultVoice;
  const voices = opts.voices;
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  // One-time migration: persist the default for bots still holding a stale voice.
  useEffect(() => {
    if (!optsLoaded || migrated.current) return;
    if (bot.voice && !opts.voices.some((v) => v.id === bot.voice)) {
      migrated.current = true;
      void save({ voice: defaultVoice });
    }
  }, [optsLoaded, bot.voice, bot.id, opts.voices, defaultVoice, save]);

  const preview = async () => {
    if (previewing) { stopPreview(); setPreviewing(false); return; }
    setPreviewing(true);
    setError(null);
    try {
      await previewVoice({ botId: bot.id, voice: effectiveVoice, speed: bot.voiceSpeed, language: bot.voiceLanguage });
    } catch (e) {
      setError((e as Error).message || '语音试听失败');
    } finally {
      setPreviewing(false);
    }
  };

  const talkLabel =
    talk.status === 'recording' ? 'Recording… release to send'
      : talk.status === 'waiting' ? 'Thinking…'
        : talk.status === 'playing' ? 'Speaking… tap to stop'
          : 'Hold to talk';

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <span className="voice-setting__right">
          <button
            type="button"
            className={`voice-preview${previewing ? ' is-playing' : ''}`}
            onClick={preview}
            title={previewing ? 'Stop preview' : 'Play a voice preview'}
          >
            {previewing ? 'Playing…' : 'Preview'}
          </button>
          <NativeSelect label="Voice" value={effectiveVoice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
        </span>
      </div>
      <div className="panel-row panel-row--setting">
        <span>Speed</span>
        <NativeSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <NativeSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button
        type="button"
        className={`panel-row panel-row--action panel-row--call${talk.status === 'recording' ? ' is-active' : ''}`}
        title="Hold to talk — release to send, Quinn answers by voice"
        onPointerDown={talk.onPointerDown}
        onPointerUp={talk.onPointerUp}
        onKeyDown={talk.onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name="voice_a" size={14} opacity={0.56} /> {talkLabel}
      </button>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
