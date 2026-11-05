/**
 * 输入框里的语音输入：点一下开始说，再点一下停，说的话转成文字放进输入框（2026-11-05 用户：对话框只留语音这一种额外方式）。
 * 复用录音 + 本机语音识别那条路（只录麦克风）；转完就删掉这条临时录音，不在任务中心里留一条。
 */
import { Loader2, Mic, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import { recordingStart, recordingStop, recordSpeechProjection, speechModelPackStatus } from '@/api/recording';
import { recordDelete } from '@/api/taskCenter';
import type { RecordingSnapshot, RecordSpeechProjection } from '@/../shared/types/record';

/** 停下后等最终转写的上限：本机模型几秒就好，再久就用录音中已经出来的句子。 */
const FINAL_WAIT_MS = 20_000;
const POLL_MS = 600;

type Phase = 'idle' | 'starting' | 'listening' | 'transcribing';

export function transcriptText(p: RecordSpeechProjection | null): string {
  const segs = (p?.transcript?.segments ?? []).filter(s => s.track !== 'system' && s.text.trim());
  return segs.sort((a, b) => a.startSample - b.startSample).map(s => s.text.trim()).join('');
}

async function finalText(recordId: string): Promise<string> {
  const until = Date.now() + FINAL_WAIT_MS;
  let last: RecordSpeechProjection | null = null;
  while (Date.now() < until) {
    last = await recordSpeechProjection(recordId).catch((e: unknown) => { console.warn('[voice-input] 读转写 FAILED', recordId, e); return last; });
    if (last?.transcript?.state === 'recording_final') break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return transcriptText(last);
}

export function VoiceInputButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const snap = useRef<RecordingSnapshot | null>(null);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const pack = await speechModelPackStatus();
      if (!pack.usable) { setError('语音模型还没装好，在设置里装一下'); setPhase('idle'); return; }
      snap.current = (await recordingStart({ microphone: true, system: false })).snapshot;
      setPhase('listening');
    } catch (e) {
      console.error('[voice-input] 开始录音 FAILED', e);
      setError('麦克风没打开，再点一次');
      setPhase('idle');
    }
  };

  const stop = async () => {
    const current = snap.current;
    if (!current) { setPhase('idle'); return; }
    setPhase('transcribing');
    try {
      await recordingStop(current);
      const text = await finalText(current.recordId);
      if (text) onText(text); else setError('没听清，再说一次');
    } catch (e) {
      console.error('[voice-input] 结束录音 FAILED', current.recordId, e);
      setError('没转成文字，再说一次');
    } finally {
      snap.current = null;
      setPhase('idle');
      void recordDelete(current.recordId).catch((e: unknown) => console.warn('[voice-input] 删临时录音 FAILED', current.recordId, e));
    }
  };

  const listening = phase === 'listening';
  const busy = phase === 'starting' || phase === 'transcribing';
  return (
    <span className="relative flex items-center">
      {error && <span role="alert" className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md bg-[var(--paper)] px-2 py-1 text-xs text-[var(--danger)] shadow">{error}</span>}
      <button
        type="button"
        aria-label={listening ? '说完了' : '语音输入'}
        aria-pressed={listening}
        disabled={disabled || busy}
        onClick={() => void (listening ? stop() : start())}
        className={`rounded-lg p-2 transition-colors disabled:cursor-wait ${listening ? 'bg-[var(--danger)]/10 text-[var(--danger)]' : 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]'}`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
    </span>
  );
}
