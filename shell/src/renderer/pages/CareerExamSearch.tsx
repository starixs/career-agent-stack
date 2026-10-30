/**
 * 笔试助力 · 搜题：截图或粘贴题目 → 先查题库（同公司同岗位往年题 → 同岗位别家 → 同类题）→ 出答案、解析、类似题。
 * 现场答题要快：粘贴即搜，答案先行；题库原题当场给答案，其余题等模型作答。
 * 搜过的题留作自己的记录，不回流题库；题库在「题库」页签上传和管理。
 */
import { useCallback, useEffect, useState } from 'react';

import { onEvent } from '@/api/eventBus';

import { BankManager } from '@/components/career/exam-search/BankManager';
import { examSearchApi, type ExamContext } from '@/components/career/exam-search/examSearchApi';
import { HistoryList } from '@/components/career/exam-search/HistoryList';
import { PasteZone, normalizeScreenshot } from '@/components/career/exam-search/PasteZone';
import { EXAM_SEARCH_CONTEXT_EVENT, takeExamSearchContext, type ExamSearchContext } from '@/components/career/exam-search/searchContext';
import { SearchResult } from '@/components/career/exam-search/SearchResult';
import { useExamSearch, type SearchPhase } from '@/components/career/exam-search/useExamSearch';
import { ErrorRow, LoadingRow, SectionTitle, TextInput, relativeTime } from '@/components/career/CareerPrimitives';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

type Tab = 'search' | 'bank';

const PHASE_TEXT: Partial<Record<SearchPhase, string>> = { recognizing: '正在认题、查题库…', answering: '题库里没有的题，正在作答…' };

function ContextBar({ company, role, onChange }: { company: string; role: string; onChange: (next: ExamSearchContext) => void }) {
  const contexts = useCareerQuery(examSearchApi.contexts, ['deadline']);
  const list = contexts.data ?? [];
  const pick = (ctx: ExamContext) => onChange({ company: ctx.company_name ?? '', role: ctx.role_title ?? '' });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs text-[var(--muted)]">这场笔试</span>
      <TextInput aria-label="公司" placeholder="公司" value={company} onChange={e => onChange({ company: e.target.value, role })} className="w-36" />
      <TextInput aria-label="岗位" placeholder="岗位" value={role} onChange={e => onChange({ company, role: e.target.value })} className="w-40" />
      {list.map(ctx => (
        <button
          key={ctx.deadline_id} type="button" onClick={() => pick(ctx)}
          className="rounded-full border border-[var(--line)] px-2.5 py-0.5 text-xs text-[var(--ink-2)] hover:bg-[var(--hover)]"
        >
          {[ctx.company_name ?? ctx.title, ctx.role_title].filter(Boolean).join(' · ')}<span className="text-[var(--subtle)]"> · {relativeTime(ctx.due_at)}</span>
        </button>
      ))}
    </div>
  );
}

/** 这场笔试默认是谁：别的页面带过来的优先，否则取最近的一场笔试 / 测评。 */
function useSearchContext(): [ExamSearchContext, (next: ExamSearchContext) => void] {
  const [handedOver] = useState(takeExamSearchContext);
  const [context, setContext] = useState<ExamSearchContext>(handedOver ?? { company: '', role: '' });
  useEffect(() => onEvent<ExamSearchContext>(EXAM_SEARCH_CONTEXT_EVENT, next => { if (next) setContext(next); }), []);
  useEffect(() => {
    if (handedOver) return undefined;
    let cancelled = false;
    examSearchApi.contexts()
      .then(list => { const first = list[0]; if (!cancelled && first) setContext({ company: first.company_name ?? '', role: first.role_title ?? '' }); })
      .catch(err => console.warn('[exam-search] 取最近的笔试失败', err));
    return () => { cancelled = true; };
  }, [handedOver]);
  return [context, setContext];
}

function SearchPane() {
  const history = useCareerQuery(examSearchApi.history, ['exam_search']);
  const search = useExamSearch(history.reload);
  const removeAction = useCareerAction();
  const [context, setContext] = useSearchContext();
  const [preview, setPreview] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const onImage = useCallback((blob: Blob) => {
    setLocalError(null);
    normalizeScreenshot(blob)
      .then(({ input, preview: url }) => { setPreview(url); search.run({ image: input, companyName: context.company, roleTitle: context.role }); })
      .catch(err => setLocalError(`读不了这张图：${err instanceof Error ? err.message : String(err)}`));
  }, [context, search]);
  const onText = useCallback((text: string) => {
    setLocalError(null);
    setPreview(null);
    search.run({ text, companyName: context.company, roleTitle: context.role });
  }, [context, search]);

  const busy = search.phase === 'recognizing' || search.phase === 'answering';
  const record = search.record;
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-4">
        <ContextBar company={context.company} role={context.role} onChange={setContext} />
        <PasteZone busy={busy} preview={preview} onImage={onImage} onText={onText} onError={setLocalError} />
        {localError && <ErrorRow message={localError} />}
        {search.error && <ErrorRow message={search.error} onRetry={record && record.questions.length > 0 ? search.retryAnswer : undefined} />}
        {PHASE_TEXT[search.phase] && <LoadingRow text={PHASE_TEXT[search.phase]} />}
        {record && record.questions.length > 0 && <SearchResult questions={record.questions} answers={record.answers} pending={search.phase === 'answering'} />}
      </div>
      <aside className="min-w-0">
        <SectionTitle>搜过的题</SectionTitle>
        {history.error && <ErrorRow message={history.error} onRetry={history.reload} />}
        {removeAction.error && <ErrorRow message={removeAction.error} />}
        <HistoryList
          records={history.data ?? []} activeId={record?.id ?? null}
          onOpen={item => { setPreview(null); search.show(item); }}
          onRemove={item => { void removeAction.run(async () => { await examSearchApi.removeSearch(item.id); history.reload(); }); }}
        />
      </aside>
    </div>
  );
}

export default function CareerExamSearch() {
  const [tab, setTab] = useState<Tab>('search');
  return (
    <div className="max-w-6xl space-y-5 px-6 py-6">
      <div role="tablist" aria-label="笔试助力" className="flex gap-1 text-sm">
        {([['search', '搜题'], ['bank', '题库']] as const).map(([id, label]) => (
          <button
            key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 ${tab === id ? 'bg-[var(--hover)] font-semibold text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'search' ? <SearchPane /> : <BankManager />}
    </div>
  );
}
