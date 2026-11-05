/**
 * 左栏：复制题目（文字或截图）后粘贴（Mac ⌘V / Windows Ctrl+V），粘进来就搜，不用点按钮（现场答题要快）。
 * 页面在时整页监听粘贴；焦点在输入框里粘贴文字不拦（那是在填公司 / 岗位），粘贴图片照样接住。
 * 左栏不放原图：认完题后按模型抄下的材料、题干、选项统一排版（记录里也只存这份文字），
 * 截图和粘贴的文字看起来一样，题号和右栏答案对得上。还在认题时先显示粘进来的原样。
 */
import { ClipboardPaste } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';

import Markdown from '@/components/Markdown';

import { formatAccelerator } from '@/utils/formatAccelerator';

import type { ExamSearchRecord, QuestionType, ScreenshotInput } from './examSearchApi';
import type { ExamStep } from './useExamSession';

/** Retina 截图常有四五千像素宽，缩到这个长边再传，题目文字依然清楚，上传和模型都更快。 */
const MAX_IMAGE_SIDE = 2000;

export async function normalizeScreenshot(blob: Blob): Promise<{ input: ScreenshotInput; preview: string }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持处理图片');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const preview = canvas.toDataURL('image/png');
  return { input: { mediaType: 'image/png', data: preview.slice(preview.indexOf(',') + 1) }, preview };
}

function imageFrom(items: DataTransferItemList | null | undefined): File | null {
  for (const item of Array.from(items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/** 粘贴键按系统显示：Mac「⌘V」、Windows「Ctrl+V」。 */
export const PASTE_KEY = formatAccelerator('CmdOrCtrl+V');

/** 整页接住粘贴：图片、文字都算一次粘贴。 */
export function usePasteListener(onImage: (image: Blob) => void, onText: (text: string) => void): void {
  const handlers = useRef({ onImage, onText });
  useEffect(() => { handlers.current = { onImage, onText }; });
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const image = imageFrom(event.clipboardData?.items);
      if (image) { event.preventDefault(); handlers.current.onImage(image); return; }
      if (isTypingTarget(event.target)) return;
      const pasted = event.clipboardData?.getData('text/plain')?.trim();
      if (pasted) { event.preventDefault(); handlers.current.onText(pasted); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
}

const QTYPE_LABEL: Record<QuestionType, string> = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '简答', personality: '性格测评' };

/** 认出来的题统一排版：共用材料在前，每题题号 + 题型 + 题干，选项一行一个。 */
export function QuestionSheet({ record }: { record: ExamSearchRecord }) {
  return (
    <div className="space-y-4">
      {record.material && (
        <div className="rounded-lg bg-[var(--hover)] px-3 py-2 text-sm text-[var(--ink-2)]">
          <Markdown compact>{record.material}</Markdown>
        </div>
      )}
      <ol className="space-y-4">
        {record.questions.map(q => (
          <li key={q.index} className="grid grid-cols-[1.5rem_1fr] gap-x-2">
            <span className="pt-0.5 text-right text-sm font-semibold tabular-nums text-[var(--subtle)]">{q.index + 1}</span>
            <div className="min-w-0 space-y-1">
              <p className="text-sm leading-relaxed text-[var(--ink)]">
                {q.qtype && <span className="mr-1.5 rounded bg-[var(--hover)] px-1 py-px text-xs text-[var(--muted)]">{QTYPE_LABEL[q.qtype]}</span>}
                {q.stem}
              </p>
              {q.options.length > 0 && (
                <ul className="space-y-0.5 text-sm text-[var(--ink-2)]">
                  {q.options.map(option => <li key={option}>{option}</li>)}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepSource({ step }: { step: ExamStep }) {
  if (step.record && step.record.questions.length > 0) return <QuestionSheet record={step.record} />;
  if (step.preview) return <img src={step.preview} alt="粘进来的截图" className="max-h-full w-full rounded-md object-contain object-top opacity-70" />;
  if (step.text) return <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink-2)]">{step.text}</p>;
  return <p className="text-sm text-[var(--subtle)]">这一步没认出题目。</p>;
}

export function SourcePane({ step, onImage, onError }: {
  step: ExamStep | null;
  onImage: (file: Blob) => void;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = Array.from(event.dataTransfer.files).find(f => f.type.startsWith('image/'));
    if (file) onImage(file);
    else onError(`只能拖图片进来；文字复制后按 ${PASTE_KEY} 就行`);
  };
  return (
    <section
      aria-label="粘进来的题目"
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`h-full min-h-[24rem] overflow-y-auto rounded-xl border px-5 py-4 transition-colors ${dragging ? 'border-[var(--primary)] bg-[var(--mint)]' : 'border-[var(--line)] bg-[var(--paper)]'}`}
    >
      {step ? <StepSource step={step} /> : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <ClipboardPaste className="h-8 w-8 text-[var(--subtle)]" strokeWidth={1.5} aria-hidden />
          <div className="font-human text-base font-semibold text-[var(--ink)]">复制题目，按 {PASTE_KEY}</div>
          <div className="text-xs text-[var(--muted)]">文字、截图都行，一次几道题也行</div>
        </div>
      )}
    </section>
  );
}
