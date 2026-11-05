/**
 * 复盘的输入（2026-11-05 用户定：复盘先有输入，最方便的是直接把录音放进来）。
 * - 录音：一块能直接拖进来的框，点它也能选文件；存到本机、挂在这场面试上，转成文字后复盘。
 *   语音识别还没接上：录音先停在「等转写」（沙漏），不假装已经在复盘。
 * - 说几句：次要入口，点开才出输入框；在这一页直接复盘（POST /interviews/:id/retro），不绕到对话。
 */
import { AudioLines, Check, Hourglass, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';

import { track } from '@/analytics';

import { careerApi } from './careerApi';
import { Button, ErrorRow, TextArea } from './CareerPrimitives';
import { readAsBase64 } from './fileBase64';
import type { Interview, InterviewRecording } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

/** 与服务端 MAX_RECORDING_BYTES 一致：一小时左右的录音。 */
const MAX_RECORDING_MB = 50;
const ACCEPT = 'audio/*,.m4a,.mp3,.wav,.aac,.amr';

const STATUS_ICON: Record<InterviewRecording['status'], { icon: ReactNode; label: string }> = {
  awaiting_asr: { icon: <Hourglass className="h-3.5 w-3.5 text-[var(--muted)]" />, label: '等转写' },
  transcribed: { icon: <Check className="h-3.5 w-3.5 text-[var(--success)]" />, label: '已转写' },
  failed: { icon: <X className="h-3.5 w-3.5 text-[var(--danger)]" />, label: '转写失败' },
};

function DropZone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  };
  return (
    <>
      <input
        ref={inputRef} type="file" accept={ACCEPT} className="hidden" aria-label="选择录音文件"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onFile(file); }}
      />
      <button
        type="button" disabled={busy} onClick={() => inputRef.current?.click()}
        onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed px-6 py-10 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${over ? 'border-[var(--primary)] bg-[var(--selected)] text-[var(--ink)]' : 'border-[var(--line-2)] bg-[var(--paper)] text-[var(--ink-2)] hover:border-[var(--hard)]'}`}
      >
        <Upload className="h-7 w-7 text-[var(--primary)]" aria-hidden />
        {busy ? '正在收录音' : '把面试录音拖进来'}
      </button>
    </>
  );
}

export function InterviewRetroBox({ interview }: { interview: Interview }) {
  const [typing, setTyping] = useState(false);
  const [words, setWords] = useState('');
  const upload = useCareerAction();
  const retro = useCareerAction();
  const recordings = useCareerQuery(() => careerApi.interviewRecordings(interview.id), ['interview']);

  const onFile = (file: File) => void upload.run(async () => {
    if (file.size > MAX_RECORDING_MB * 1024 * 1024) throw new Error(`录音超过 ${MAX_RECORDING_MB}MB，剪短一点再传`);
    await careerApi.uploadInterviewRecording(interview.id, { name: file.name, mime: file.type || undefined, data: await readAsBase64(file) });
    track('career_retro_submit', { kind: 'recording' });
    recordings.reload();
  });
  const submitWords = () => void retro.run(async () => {
    await careerApi.retroInterview(interview.id, words.trim());
    track('career_retro_submit', { kind: 'words' });
    setWords('');
  });

  return (
    <div className="space-y-3" data-testid="interview-retro-box">
      <DropZone busy={upload.busy} onFile={onFile} />
      {upload.error && <ErrorRow message={upload.error} />}
      {(recordings.data ?? []).length > 0 && (
        <ul aria-label="录音" className="flex flex-wrap gap-2">
          {(recordings.data ?? []).map(recording => (
            <li key={recording.id} className="flex items-center gap-1.5 rounded-full bg-[var(--inset)] px-3 py-1 text-sm text-[var(--ink-2)]">
              <AudioLines className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="max-w-48 truncate">{recording.name}</span>
              <span role="img" aria-label={STATUS_ICON[recording.status].label} title={STATUS_ICON[recording.status].label}>{STATUS_ICON[recording.status].icon}</span>
            </li>
          ))}
        </ul>
      )}
      {typing ? (
        <div className="space-y-2">
          <TextArea value={words} onChange={event => setWords(event.target.value)} placeholder="被问了什么、怎么答的、哪里卡住了" aria-label="说几句复盘" />
          <Button variant="primary" busy={retro.busy} disabled={!words.trim()} onClick={submitWords}>{retro.busy ? '正在复盘' : '开始复盘'}</Button>
          {retro.error && <ErrorRow message={retro.error} />}
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setTyping(true)}>没有录音，说几句</Button>
      )}
    </div>
  );
}
