/**
 * 笔试助力：以一场笔试为单位。复制题目（文字或截图）粘贴（⌘V / Ctrl+V）→ 左栏是粘进来的题，右栏是答案；
 * 中间的箭头（或键盘 ← →）在这场的每次粘贴之间前后翻。考完在「记录」里按场回看，点开还能接着粘。
 * 「开始这场」以后点一下宠物就框选截图，截图挂在宠物身上，截够了一口气发出去（宠物的小面板或这里都能发）。
 * 先查题库（同公司同岗位往年题 → 同岗位别家 → 同类题）再作答；题库的上传和管理先不露出。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';

import { examSearchApi, type ExamContext, type LiveExam } from '@/components/career/exam-search/examSearchApi';
import { AnswerPane, ExamSample, StepArrows } from '@/components/career/exam-search/ExamSteps';
import { notifyPet } from '@/components/career/exam-search/petBridge';
import { EXAM_SEARCH_CONTEXT_EVENT, takeExamSearchContext } from '@/components/career/exam-search/searchContext';
import { SessionList } from '@/components/career/exam-search/SessionList';
import { ShotTray } from '@/components/career/exam-search/ShotTray';
import { SourcePane, normalizeScreenshot, usePasteListener } from '@/components/career/exam-search/SourcePane';
import { stepFromRecord, useExamSession, type ExamSessionState, type Who } from '@/components/career/exam-search/useExamSession';
import { touchesExamSearch, useLiveExam, type DataChanged } from '@/components/career/exam-search/useLiveExam';
import { Badge, Button, ErrorRow, TextInput, relativeTime } from '@/components/career/CareerPrimitives';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

type Tab = 'answer' | 'records';

/** 打开页面时，最近一场在这么久以内还算「正在考」，直接接着那场。 */
const RESUME_WINDOW_MS = 3 * 3_600_000;

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

type LiveState = ReturnType<typeof useLiveExam>;

function LiveActions({ isLive, onStart, onEnd, onNew }: { isLive: boolean; onStart: () => void; onEnd: () => void; onNew: () => void }) {
  if (isLive) {
    return (
      <span className="ml-auto flex items-center gap-2">
        <Badge tone="success">正在考</Badge>
        <Button size="sm" onClick={onEnd}>结束这场</Button>
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-2">
      <Button size="sm" variant="primary" onClick={onStart}>开始这场</Button>
      <Button size="sm" onClick={onNew}>新的一场</Button>
    </span>
  );
}

function WhoBar({ who, onChange, children }: { who: Who; onChange: (next: Who) => void; children: ReactNode }) {
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
      {children}
    </div>
  );
}

/** 打开页面时这场是谁：别的页面带过来的开新的一场；正在考的那场优先；否则最近一场还没过多久就接着，不然取最近的笔试 / 测评。 */
function useOpening(exam: ExamSessionState, open: (id: string) => Promise<void>) {
  const { switchTo } = exam;
  const [handedOver] = useState(takeExamSearchContext);
  useEffect(() => onEvent<Who>(EXAM_SEARCH_CONTEXT_EVENT, next => { if (next) switchTo({ id: null, who: next, steps: [] }); }), [switchTo]);
  useEffect(() => {
    if (handedOver) { switchTo({ id: null, who: handedOver, steps: [] }); return undefined; }
    let cancelled = false;
    void (async () => {
      const { session: live } = await examSearchApi.live();
      if (cancelled) return;
      if (live) { await open(live.id); return; }
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

/** 侧车这场的记录变了（宠物发出去的题、作答完）：拉一次合进来。 */
function useSessionSync(exam: ExamSessionState) {
  const { sessionId, sync } = exam;
  useEffect(() => onEvent<DataChanged>('career:data-changed', payload => {
    if (!sessionId || !touchesExamSearch(payload)) return;
    examSearchApi.session(sessionId)
      .then(({ searches }) => sync(sessionId, searches))
      .catch(err => console.warn(`[exam-search] 同步这场 ${sessionId} 失败`, err));
  }), [sessionId, sync]);
}

function LivePanel({ live, exam }: { live: LiveExam; exam: ExamSessionState }) {
  const [busy, setBusy] = useState(false);
  const send = () => {
    setBusy(true);
    void exam.sendPetShots(live.shots[0]?.thumb ?? null).finally(() => { setBusy(false); notifyPet(); });
  };
  const remove = (id: string) => {
    examSearchApi.removeShot(id).then(() => notifyPet()).catch(err => console.warn(`[exam-search] 去掉截图 ${id} 失败`, err));
  };
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
      <ShotTray shots={live.shots} busy={busy} onRemove={shot => remove(shot.id)} onSend={send} />
    </div>
  );
}

function AnswerTab({ exam, live, onNew }: { exam: ExamSessionState; live: LiveState; onNew: () => void }) {
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
  useSessionSync(exam);
  const isLive = live.live.session !== null && live.live.session.id === exam.sessionId;
  const { switchTo } = exam;
  const start = async () => {
    const session = await live.start({ sessionId: exam.sessionId, ...exam.who });
    if (session && session.id !== exam.sessionId) {
      switchTo({ id: session.id, who: { company: session.company_name ?? '', role: session.role_title ?? '' }, steps: [] });
    }
  };
  return (
    <div className="space-y-4">
      <WhoBar who={exam.who} onChange={exam.setWho}>
        <LiveActions isLive={isLive} onStart={() => void start()} onEnd={() => void live.end()} onNew={onNew} />
      </WhoBar>
      {live.error && <ErrorRow message={live.error} />}
      {isLive && <LivePanel live={live.live} exam={exam} />}
      {localError && <ErrorRow message={localError} />}
      <div className="grid h-[calc(100vh-14rem)] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4">
        <SourcePane step={exam.current} onImage={onImage} onError={setLocalError} />
        <StepArrows index={exam.index} total={exam.steps.length} onGo={exam.go} />
        <AnswerPane step={exam.current} onRetry={exam.retry} empty={<ExamSample />} />
      </div>
    </div>
  );
}

export default function CareerExamSearch() {
  const [tab, setTab] = useState<Tab>('answer');
  const sessions = useCareerQuery(examSearchApi.sessions, ['exam_search']);
  const exam = useExamSession(sessions.reload);
  const live = useLiveExam();
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
      {tab === 'answer' ? <AnswerTab exam={exam} live={live} onNew={startNew} /> : (
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
