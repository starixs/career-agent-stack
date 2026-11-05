/**
 * 一场笔试里前后翻的两块：中间的箭头（第几 / 共几）和右栏的答案。主窗口和宠物的小面板共用。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import { SearchResult } from './SearchResult';
import type { ExamStep } from './useExamSession';

/** row：宠物小面板里横着放。 */
export function StepArrows({ index, total, onGo, row = false }: { index: number; total: number; onGo: (delta: number) => void; row?: boolean }) {
  const arrow = 'rounded-full border border-[var(--line)] p-2 text-[var(--ink-2)] hover:bg-[var(--hover)] disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className={`flex items-center justify-center gap-2 ${row ? '' : 'flex-col'}`}>
      <button type="button" aria-label="上一次" className={arrow} disabled={index <= 0} onClick={() => onGo(-1)}>
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <span className="text-xs tabular-nums text-[var(--muted)]">{total > 0 ? `${index + 1} / ${total}` : '0 / 0'}</span>
      <button type="button" aria-label="下一次" className={arrow} disabled={index >= total - 1} onClick={() => onGo(1)}>
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

const STATUS_TEXT: Partial<Record<ExamStep['status'], string>> = { recognizing: '正在认题、查题库…', answering: '正在作答…' };

/** compact：宠物小面板里用，去掉边框和最小高度。 */
export function AnswerPane({ step, onRetry, compact = false }: { step: ExamStep | null; onRetry: (step: ExamStep) => void; compact?: boolean }) {
  const record = step?.record;
  const canRetry = step?.status === 'error' && record && record.questions.length > 0;
  const frame = compact ? 'px-1' : 'h-full min-h-[24rem] overflow-y-auto rounded-xl border border-[var(--line)] px-5 py-2';
  return (
    <section aria-label="答案" className={frame}>
      {!step && <p className="py-6 text-sm text-[var(--subtle)]">答案会出现在这里。</p>}
      {step && STATUS_TEXT[step.status] && <LoadingRow text={STATUS_TEXT[step.status]} />}
      {step?.error && <ErrorRow message={step.error} onRetry={canRetry ? () => onRetry(step) : undefined} />}
      {record && record.questions.length > 0 && <SearchResult questions={record.questions} answers={record.answers} pending={step.status === 'answering'} />}
    </section>
  );
}
