/**
 * 面试助力 ·「题库」。这一页分得清两件事（2026-11-05 用户定）：
 *   练：不让他一道道挑。上面一张卡，一根比例条（过关 / 没过关 / 没练过）加一个「开始练」，点了由小芽发题，
 *       没练过的和分数低的先来——所以也没有「只看没练 / 不到 60 分」这种筛选。
 *   看：下面是题目卡，题干加一个分数环；点开一张看考察点、参考答案和每次作答的分数。题目行上没有按钮。
 * 字只用两档：题干和控件 14px，展开后的小标签 12px。来源用上面的分段切换表达，不在每道题上挂标签。
 * 补录自己见过的题在右上角，是次要入口。
 */
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { careerApi } from './careerApi';
import { Button, ErrorRow, LoadingRow, Select, TextArea, TextInput, formatDate, useSuggestToChat } from './CareerPrimitives';
import { SAMPLE_QUESTIONS } from './skills/samples/interview';
import { SampleFrame } from './skills/samples/SampleFrame';
import { useSampleMode } from './skills/samples/sampleMode';
import { PASS_SCORE, ScoreRing, SegmentBar, Tag } from './skills/visual';
import type { QuestionItem } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

type SourceFilter = '' | QuestionItem['source'];
const SOURCES: ReadonlyArray<{ value: SourceFilter; label: string; scope: string }> = [
  { value: '', label: '全部', scope: '题库里' },
  { value: 'seen', label: '我见过的', scope: '我见过的题里' },
  { value: 'generated', label: '按岗位出的', scope: '按岗位出的题里' },
  { value: 'public', label: '公共题库', scope: '公共题库里' },
];
const KIND: Record<QuestionItem['kind'], string> = { interview: '面试', written: '笔试', assessment: '测评' };
/** 这一页发出去的话，回复结束后带他回到面试助力。 */
const SURFACE = pageSurfaceId({ kind: 'career-dossier', view: 'interview' });
/** 一次先摆这么多张题目卡，多的点「再看一些」。 */
const PAGE_SIZE = 40;

const lastScore = (item: QuestionItem): number | null => (item.attempt_count ? item.last_attempt_score : null);

/** 练：一根比例条说清这批题练到哪了，一个按钮开始。 */
function PracticeDeck({ items, onStart }: { items: QuestionItem[]; onStart: () => void }) {
  const scores = items.map(lastScore);
  const passed = scores.filter(score => score !== null && score >= PASS_SCORE).length;
  const fresh = scores.filter(score => score === null).length;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] px-5 py-4 shadow-hard-lg">
      <div className="min-w-48 flex-1">
        <SegmentBar
          legend={false} label="练习情况"
          segments={[{ label: '过关', value: passed, tone: 'success' }, { label: '没过关', value: items.length - passed - fresh, tone: 'warning' }, { label: '没练过', value: fresh, tone: 'neutral' }]}
        />
      </div>
      <Button variant="primary" size="lg" disabled={items.length === 0} onClick={onStart}>开始练</Button>
    </div>
  );
}

export function QuestionBankPanel() {
  const suggest = useSuggestToChat();
  const query = useCareerQuery(() => careerApi.questions(), ['question']);
  const [source, setSource] = useState<SourceFilter>('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const keyword = search.trim().toLowerCase();
  const shown = (query.data ?? []).filter(item => (!source || item.source === source)
    && (!keyword || [item.content, item.company_name, item.category, KIND[item.kind]].some(field => field?.toLowerCase().includes(keyword))));
  const scope = SOURCES.find(option => option.value === source)?.scope ?? '题库里';
  const start = () => suggest(`从${scope}挑${keyword ? `和「${search.trim()}」有关的` : ''}题考我，先考没练过的和分数低的`, { surface: SURFACE });
  const empty = query.data?.length === 0;
  return (
    <section className="max-w-5xl space-y-5">
      {!empty && <PracticeDeck items={shown} onStart={start} />}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="题目来源" className="flex gap-1 rounded-lg bg-[var(--inset)] p-1">
          {SOURCES.map(option => (
            <button
              key={option.value} type="button" aria-pressed={source === option.value} onClick={() => { setSource(option.value); setLimit(PAGE_SIZE); }}
              className={`rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${source === option.value ? 'bg-[var(--paper)] font-medium text-[var(--ink)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="w-56"><TextInput aria-label="搜索题目" placeholder="搜题目或公司" value={search} onChange={event => { setSearch(event.target.value); setLimit(PAGE_SIZE); }} /></div>
        <Button size="sm" variant="ghost" onClick={() => setAdding(value => !value)}><Plus className="h-3.5 w-3.5" />补录见过的题</Button>
      </div>
      {adding && <AddQuestion onDone={() => { setAdding(false); query.reload(); }} />}
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !query.data && <LoadingRow />}
      {empty && <SampleBank />}
      {!empty && query.data && shown.length === 0 && <div className="text-sm text-[var(--muted)]">还没有题目</div>}
      <ul aria-label="题目" className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {shown.slice(0, limit).map(item => <QuestionCard key={item.id} item={item} onChanged={query.reload} />)}
      </ul>
      {shown.length > limit && <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setLimit(value => value + PAGE_SIZE)}>再看一些</Button>}
    </section>
  );
}

/** 题库里一道题都还没有：用示例的几道把「练到哪了」和题目卡摆出来。 */
function SampleBank() {
  return (
    <SampleFrame>
      <PracticeDeck items={SAMPLE_QUESTIONS} onStart={() => undefined} />
      <ul aria-label="题目" className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {SAMPLE_QUESTIONS.map(item => <QuestionCard key={item.id} item={item} onChanged={() => undefined} />)}
      </ul>
    </SampleFrame>
  );
}

/** 看：一道题一张卡，题干加分数环；点开是考察点、参考答案、每次作答的分数。 */
function QuestionCard({ item, onChanged }: { item: QuestionItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  // 示例题不在库里，不去读作答记录
  const sample = useSampleMode();
  const attempts = useCareerQuery(() => (open && !sample ? careerApi.questionAttempts(item.id) : Promise.resolve([])), ['question']);
  const act = useCareerAction();
  const tags = [KIND[item.kind], item.company_name, ...safeList(item.probe_points_json)].filter((tag): tag is string => !!tag);
  return (
    <li className={`rounded-lg border-[1.5px] bg-[var(--paper)] ${open ? 'border-[var(--hard)]' : 'border-[var(--line)]'}`}>
      <button
        type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); attempts.reload(); }}
        className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <ScoreRing score={lastScore(item)} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink)]">{item.content}</span>
      </button>
      {open && (
        <div className="space-y-3 pb-3 pl-14 pr-3">
          <div className="flex flex-wrap gap-1.5">{tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>
          {item.reference && <div role="note" aria-label="参考答案" className="rounded-md bg-[var(--note)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)]">{item.reference}</div>}
          <div className="flex items-center gap-1.5">
            <ul aria-label="作答记录" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {(attempts.data ?? []).map(attempt => <li key={attempt.id} title={formatDate(attempt.created_at)}><ScoreRing score={attempt.score} label={`${formatDate(attempt.created_at)} ${attempt.score ?? '没打'} 分`} /></li>)}
            </ul>
            <Button size="sm" variant="ghost" aria-label="删除题目" busy={act.busy} onClick={() => void act.run(async () => { await careerApi.deleteQuestion(item.id); onChanged(); })}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
          {act.error && <ErrorRow message={act.error} />}
        </div>
      )}
    </li>
  );
}

function AddQuestion({ onDone }: { onDone: () => void }) {
  const [content, setContent] = useState('');
  const [company, setCompany] = useState('');
  const [kind, setKind] = useState('interview');
  const act = useCareerAction();
  const save = () => act.run(async () => {
    const lines = content.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('写下题目（一行一道）');
    for (const line of lines) await careerApi.addQuestion({ content: line, kind, company_name: company.trim() || undefined, source: 'seen' });
    setContent(''); onDone();
  });
  return (
    <div className="space-y-2 rounded-lg bg-[var(--inset)] p-3">
      <TextArea aria-label="见过的题" placeholder="一行一道，按原话写" rows={3} value={content} onChange={e => setContent(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <TextInput aria-label="哪家公司" placeholder="哪家公司（可选）" value={company} onChange={e => setCompany(e.target.value)} className="w-40" />
        <Select ariaLabel="补录类型" value={kind} onChange={setKind} options={[{ value: 'interview', label: '面试题' }, { value: 'written', label: '笔试题' }, { value: 'assessment', label: '测评题' }]} />
        <Button size="sm" variant="primary" busy={act.busy} onClick={() => void save()}>存进题库</Button>
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function safeList(raw: string): string[] { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } }
