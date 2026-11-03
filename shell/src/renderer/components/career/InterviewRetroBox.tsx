/**
 * 面完复盘的两个入口：传一段自己录的录音，或者说几句。
 * - 录音：存到本机、挂在这场面试上，等语音识别转成文字后复盘（识别还没接，先显示「等待转写」）；
 * - 说几句：在这一页直接复盘（POST /interviews/:id/retro），结果写回这场面试、就显示在上面；
 *   不绕到对话里，对话只在复盘冒出新说法时出一张确认卡。
 */
import { Mic, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { careerApi } from './careerApi';
import { Button, ErrorRow, TextArea } from './CareerPrimitives';
import { readAsBase64 } from './fileBase64';
import type { Interview, InterviewRecording } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

const RECORDING_STATUS: Record<InterviewRecording['status'], string> = {
  awaiting_asr: '已收到，等语音识别转成文字后复盘',
  transcribed: '已转写',
  failed: '转写失败',
};
/** 与服务端 MAX_RECORDING_BYTES 一致：一小时左右的录音。 */
const MAX_RECORDING_MB = 50;

export function InterviewRetroBox({ interview }: { interview: Interview }) {
  const [mode, setMode] = useState<'words' | 'recording'>('words');
  const [words, setWords] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useCareerAction();
  const retro = useCareerAction();
  const recordings = useCareerQuery(() => careerApi.interviewRecordings(interview.id), ['interview']);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void upload.run(async () => {
      if (file.size > MAX_RECORDING_MB * 1024 * 1024) throw new Error(`录音超过 ${MAX_RECORDING_MB}MB，剪短一点再传`);
      await careerApi.uploadInterviewRecording(interview.id, { name: file.name, mime: file.type || undefined, data: await readAsBase64(file) });
      recordings.reload();
    });
  };

  return (
    <div className="space-y-3" data-testid="interview-retro-box">
      <div role="tablist" className="flex gap-1.5">
        <Button size="sm" variant={mode === 'words' ? 'primary' : 'ghost'} onClick={() => setMode('words')} aria-selected={mode === 'words'}><Mic className="h-3.5 w-3.5" />说几句</Button>
        <Button size="sm" variant={mode === 'recording' ? 'primary' : 'ghost'} onClick={() => setMode('recording')} aria-selected={mode === 'recording'}><Upload className="h-3.5 w-3.5" />传录音</Button>
      </div>
      {mode === 'words' && (
        <div className="space-y-2">
          <TextArea value={words} onChange={e => setWords(e.target.value)} placeholder="被问了什么、哪里卡住了、面试官的反应……想到哪说到哪" aria-label="说几句复盘" />
          <Button variant="primary" size="sm" busy={retro.busy} disabled={!words.trim()} onClick={() => void retro.run(async () => { await careerApi.retroInterview(interview.id, words.trim()); setWords(''); })}>{retro.busy ? '正在复盘' : '开始复盘'}</Button>
          {retro.error && <ErrorRow message={retro.error} />}
        </div>
      )}
      {mode === 'recording' && (
        <div className="space-y-2">
          <input ref={inputRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.amr" className="hidden" onChange={onFile} aria-label="选择录音文件" />
          <Button size="sm" busy={upload.busy} onClick={() => inputRef.current?.click()}>选一段录音</Button>
          <p className="text-xs text-[var(--subtle)]">手机或电脑录的都行（m4a / mp3 / wav），不超过 {MAX_RECORDING_MB}MB。录音只存在这台电脑上。</p>
          {upload.error && <ErrorRow message={upload.error} />}
        </div>
      )}
      {(recordings.data ?? []).length > 0 && (
        <ul className="space-y-1 text-xs text-[var(--muted)]">
          {(recordings.data ?? []).map(r => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="truncate text-[var(--ink-2)]">{r.name}</span>
              <span className="shrink-0">{RECORDING_STATUS[r.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
