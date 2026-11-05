/**
 * 笔试助力：以一场笔试为单位。复制题目（文字或截图）按 ⌘V → 左栏是粘进来的题，右栏是答案；
 * 中间的箭头（或键盘 ← →）在这场的每次粘贴之间前后翻。考完在「记录」里按场回看，点开还能接着粘。
 * 先查题库（同公司同岗位往年题 → 同岗位别家 → 同类题）再作答；题库的上传和管理先不露出。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { onEvent } from '@/api/eventBus';

import { examSearchApi, type ExamContext } from '@/components/career/exam-search/examSearchApi';
import { EXAM_SEARCH_CONTEXT_EVENT, takeExamSearchContext } from '@/components/career/exam-search/searchContext';
import { SearchResult } from '@/components/career/exam-search/SearchResult';
import { SessionList } from '@/components/career/exam-search/SessionList';
import { SourcePane, normalizeScreenshot, usePasteListener } from '@/components/career/exam-search/SourcePane';
import { stepFromRecord, useExamSession, type ExamSessionState, type ExamStep, type Who } from '@/components/career/exam-search/useExamSession';
import { Button, ErrorRow, LoadingRow, TextInput, relativeTime } from '@/components/career/CareerPrimitives';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

type Tab = 'answer' | 'records';

/** 打开页面时，最近一场在这么久以内还算「正在考」，直接接着那场。 */
const RESUME_WINDOW_MS = 3 * 3_600_000;

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

function WhoBar({ who, onChange, onNew }: { who: Who; onChange: (next: Who) => void; onNew: () => void }) {
  const contexts = useCareerQuery(examSearchApi.contexts, ['deadline']);
  const pick = (ctx: ExamContext) => onChange({ company: ctx.company_name ?? '', role: ctx.role_title ?? '' });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs text-[var(--muted)]">这场笔试</span>
      <TextInput aria-label="公司" placeholder="公司" value={who.company} onChange={e => onChange({ ...who, company: e.target.value })} className="w-36" />
      <TextInput aria-label="岗位" placeholder="岗位" value={who.role} onChange={e => onChange({ ...who, role: e.target.value })} className="w-40" />
      {(contexts.data ?? []).map(ctx => (
        <button
          key={ctx.deadline_id} type="button" onClick={() => pick(ctx)}
          className="rounded-full border border-[var(--line)] px-2.5 py-0.5 text-xs text-[var(--ink-2)] hover:bg-[var(--hover)]"
        >
          {[ctx.company_name ?? ctx.title, ctx.role_title].filter(Boolean).join(' · ')}<span className="text-[var(--subtle)]"> · {relativeTime(ctx.due_at)}</span>
        </button>
      ))}
      <Button size="sm" className="ml-auto" onClick={onNew}>新的一场</Button>
    </div>
  );
}

function StepArrows({ index, total, onGo }: { index: number; total: number; onGo: (delta: number) => void }) {
  const arrow = 'rounded-full border border-[var(--line)] p-2 text-[var(--ink-2)] hover:bg-[var(--hover)] disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="flex flex-col items-center justify-center gap-2">
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

function AnswerPane({ step, onRetry }: { step: ExamStep | null; onRetry: (step: ExamStep) => void }) {
  const record = step?.record;
  const canRetry = step?.status === 'error' && record && record.questions.length > 0;
  return (
    <section aria-label="答案" className="h-full min-h-[24rem] overflow-y-auto rounded-xl border border-[var(--line)] px-5 py-2">
      {!step && <p className="py-6 text-sm text-[var(--subtle)]">答案会出现在这里。</p>}
      {step && STATUS_TEXT[step.status] && <LoadingRow text={STATUS_TEXT[step.status]} />}
      {step?.error && <ErrorRow message={step.error} onRetry={canRetry ? () => onRetry(step) : undefined} />}
      {record && record.questions.length > 0 && <SearchResult questions={record.questions} answers={record.answers} pending={step.status === 'answering'} />}
    </section>
  );
}

/** 打开页面时这场是谁：别的页面带过来的开新的一场；否则最近一场还在考就接着，不然取最近的笔试 / 测评。 */
function useOpening(exam: ExamSessionState, open: (id: string) => Promise<void>) {
  const { switchTo } = exam;
  const [handedOver] = useState(takeExamSearchContext);
  useEffect(() => onEvent<Who>(EXAM_SEARCH_CONTEXT_EVENT, next => { if (next) switchTo({ id: null, who: next, steps: [] }); }), [switchTo]);
  useEffect(() => {
    if (handedOver) { switchTo({ id: null, who: handedOver, steps: [] }); return undefined; }
    let cancelled = false;
    void (async () => {
      const [latest] = await examSearchApi.sessions();
      if (cancelled) return;
      if (latest && Date.now() - Date.parse(latest.updated_at) < RESUME_WINDOW_MS) { await open(latest.id); return; }
      const [upcoming] = await examSearchApi.contexts();
      if (!cancelled && upcoming) switchTo({ id: null, who: { company: upcoming.company_name ?? '', role: upcoming.role_title ?? '' }, steps: [] });
    })().catch(err => console.warn('[exam-search] 打开页面时取最近一场失败', err));
    return () => { cancelled = true; };
  }, [handedOver, open, switchTo]);
}

function useArrowKeys(enabled: boolean, go: (delta: number) => void) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, go]);
}

function AnswerTab({ exam, onNew }: { exam: ExamSessionState; onNew: () => void }) {
  const [localError, setLocalError] = useState<string | null>(null);
  const { paste } = exam;
  const onImage = useCallback((blob: Blob) => {
    setLocalError(null);
    normalizeScreenshot(blob)
      .then(({ input, preview }) => paste({ image: input, preview }))
      .catch(err => setLocalError(`读不了这张图：${err instanceof Error ? err.message : String(err)}`));
  }, [paste]);
  const onText = useCallback((text: string) => { setLocalError(null); paste({ text }); }, [paste]);
  usePasteListener(onImage, onText);
  useArrowKeys(true, exam.go);
  return (
    <div className="space-y-4">
      <WhoBar who={exam.who} onChange={exam.setWho} onNew={onNew} />
      {localError && <ErrorRow message={localError} />}
      <div className="grid h-[calc(100vh-14rem)] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4">
        <SourcePane step={exam.current} onImage={onImage} onError={setLocalError} />
        <StepArrows index={exam.index} total={exam.steps.length} onGo={exam.go} />
        <AnswerPane step={exam.current} onRetry={exam.retry} />
      </div>
    </div>
  );
}

export default function CareerExamSearch() {
  const [tab, setTab] = useState<Tab>('answer');
  const sessions = useCareerQuery(examSearchApi.sessions, ['exam_search']);
  const exam = useExamSession(sessions.reload);
  const removeAction = useCareerAction();
  const { switchTo } = exam;

  const open = useCallback(async (id: string) => {
    const { session, searches } = await examSearchApi.session(id);
    switchTo({ id: session.id, who: { company: session.company_name ?? '', role: session.role_title ?? '' }, steps: searches.map(r => stepFromRecord(r)) });
  }, [switchTo]);
  useOpening(exam, open);
  const startNew = () => switchTo({ id: null, who: { company: '', role: '' }, steps: [] });

  return (
    <div className="max-w-6xl space-y-5 px-6 py-6">
      <div role="tablist" aria-label="笔试助力" className="flex gap-1 text-sm">
        {([['answer', '答题'], ['records', '记录']] as const).map(([id, label]) => (
          <button
            key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 ${tab === id ? 'bg-[var(--hover)] font-semibold text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'answer' ? <AnswerTab exam={exam} onNew={startNew} /> : (
        <div className="max-w-2xl">
          {sessions.error && <ErrorRow message={sessions.error} onRetry={sessions.reload} />}
          {removeAction.error && <ErrorRow message={removeAction.error} />}
          <SessionList
            sessions={sessions.data ?? []} activeId={exam.sessionId}
            onOpen={item => { void removeAction.run(async () => { await open(item.id); setTab('answer'); }); }}
            onRemove={item => {
              void removeAction.run(async () => {
                await examSearchApi.removeSession(item.id);
                if (item.id === exam.sessionId) switchTo({ id: null, who: { company: '', role: '' }, steps: [] });
                sessions.reload();
              });
            }}
          />
        </div>
      )}
    </div>
  );
}
