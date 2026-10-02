/**
 * 复盘：每周一次，用数字代替猜测。漏斗 + 基准线说明 + 周复盘（一件今天就能做的小事）。
 * 视图：漏斗与周复盘（新）/ 调研与方向（嵌入 CareerResearch）。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { STRENGTH_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, ChatActionButton, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, formatDate,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { CareerFocusEvent, Funnel, FunnelRow, WeeklyReview } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const CareerResearch = lazy(() => import('@/pages/CareerResearch'));

type View = 'funnel' | 'research';
const VIEWS: Array<{ value: View; label: string }> = [{ value: 'funnel', label: '漏斗与周复盘' }, { value: 'research', label: '调研与方向' }];

const EMPTY_ROW: FunnelRow = { key: 'overall', total: 0, applied: 0, responded: 0, interview: 0, offer: 0, rejected: 0, silent: 0 };

function rate(num: number, den: number): string {
  return den > 0 ? `${Math.round((num / den) * 100)}%` : '—';
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${o.value === value ? 'bg-[var(--paper)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function CareerReview({ embedded = false }: CareerPageProps) {
  const [view, setView] = useState<View>('funnel');
  const [focusId, setFocusId] = useState<string | null>(null);
  const query = useCareerQuery(careerApi.review, ['application', 'application_history', 'weekly_review', 'job']);
  const data = query.data;

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'review') return;
    setView('funnel');
    if (payload.id) setFocusId(payload.id);
  }), []);

  // 只对同一个焦点滚动一次；用户手动切视图即清除高亮。
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || !data || scrolledFor.current === focusId) return;
    const el = document.getElementById(`weekly-review-${focusId}`);
    if (!el) return;
    scrolledFor.current = focusId;
    el.scrollIntoView?.({ block: 'start' });
  }, [focusId, data]);
  const changeView = (v: View) => { setFocusId(null); setView(v); };

  return (
    <CareerPage
      embedded={embedded}
      title="复盘"
      subtitle="每周一次，用数字代替猜测"
      examples={['帮我做本周复盘', '按平台看看哪里过简历率最低', '接下来该投什么']}
      actions={<Segmented value={view} options={VIEWS} onChange={changeView} />}
    >
      {view === 'funnel' && (
        <div className="space-y-6 px-4 py-3">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !data && <LoadingRow />}
          {data && <FunnelSection funnel={data.funnel} />}
          {data && <WeeklySection reviews={data.reviews} highlightId={focusId} onChanged={query.reload} />}
        </div>
      )}
      {view === 'research' && (
        <Suspense fallback={<div className="px-4"><LoadingRow /></div>}>
          <CareerResearch embedded />
        </Suspense>
      )}
    </CareerPage>
  );
}

// ─── 漏斗 ───

function FunnelSection({ funnel }: { funnel: Funnel }) {
  const overall = funnel.overall ?? EMPTY_ROW;
  if (overall.total === 0) {
    return (
      <section>
        <SectionTitle>漏斗</SectionTitle>
        <EmptyState title="还没有投递数据。先在收件箱丢几个 JD，投出去之后这里会出现漏斗。" />
        <div className="flex justify-center">
          <ChatActionButton text="帮我看看接下来该投什么" context={{ surface: 'review' }} />
        </div>
      </section>
    );
  }
  const tiles: Array<{ label: string; value: number }> = [
    { label: '总计', value: overall.total }, { label: '已投递', value: overall.applied }, { label: '有回应', value: overall.responded },
    { label: '面试', value: overall.interview }, { label: 'Offer', value: overall.offer }, { label: '被拒', value: overall.rejected }, { label: '沉默', value: overall.silent },
  ];
  const rates: Array<{ label: string; value: string }> = [
    { label: '过简历率', value: rate(overall.responded, overall.applied) },
    { label: '面试推进率', value: rate(overall.interview, overall.responded) },
    { label: 'Offer 率', value: rate(overall.offer, overall.interview) },
  ];
  return (
    <section className="space-y-4">
      <div>
        <SectionTitle>总体</SectionTitle>
        <div className="grid grid-cols-4 gap-2 md:grid-cols-7" aria-label="总体数字">
          {tiles.map(t => (
            <div key={t.label} className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
              <div className="text-xs text-[var(--ink-muted)]">{t.label}</div>
              <div className="text-xl font-semibold tabular-nums text-[var(--ink)]" aria-label={`${t.label} ${t.value}`}>{t.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm" aria-label="转化率">
          {rates.map(r => (
            <span key={r.label} className="text-[var(--ink-muted)]">{r.label} <span className="font-semibold tabular-nums text-[var(--ink)]">{r.value}</span></span>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--ink-subtle)]">经验上网申过简历率通常只有一到两成，沉默比被拒常见；这不是能力结论。</p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <FunnelTable title="按岗位类别" rows={funnel.by_category ?? []} />
        <FunnelTable title="按平台" rows={funnel.by_platform ?? []} />
      </div>
    </section>
  );
}

const COLS: Array<{ key: keyof FunnelRow; label: string }> = [
  { key: 'total', label: '总计' }, { key: 'applied', label: '投递' }, { key: 'responded', label: '回应' },
  { key: 'interview', label: '面试' }, { key: 'offer', label: 'Offer' }, { key: 'silent', label: '沉默' },
];

/** 推进率 = 面试 / 投递；只对有投递的行比较。 */
function advanceRate(r: FunnelRow): number | null {
  return r.applied > 0 ? r.interview / r.applied : null;
}

function FunnelTable({ title, rows }: { title: string; rows: FunnelRow[] }) {
  const maxTotal = Math.max(1, ...rows.map(r => r.total));
  let best: string | null = null;
  let worst: string | null = null;
  let bestRate = -1;
  let worstRate = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const a = advanceRate(r);
    if (a == null) continue;
    if (a > bestRate) { bestRate = a; best = r.key; }
    if (r.applied >= 3 && a < worstRate) { worstRate = a; worst = r.key; }
  }
  if (best === worst) worst = null;
  return (
    <Card title={title}>
      {rows.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">还没有可以分组的数据。</div>}
      {rows.length > 0 && (
        <div className="grid grid-cols-[minmax(96px,1.4fr)_repeat(6,minmax(40px,1fr))_minmax(60px,2fr)] gap-x-2 gap-y-1 text-xs" role="table" aria-label={title}>
          <div className="contents text-[var(--ink-muted)]" role="row">
            <div role="columnheader">分组</div>
            {COLS.map(c => <div key={c.key} role="columnheader" className="text-right">{c.label}</div>)}
            <div role="columnheader" />
          </div>
          {rows.map(r => (
            <div key={r.key} className="contents" role="row">
              <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1 text-[var(--ink)]">
                <span className="truncate font-medium">{r.key || '未分类'}</span>
                {r.key === best && <Badge tone="success">走得最远</Badge>}
                {r.key === worst && <Badge tone="warning">挂得最多</Badge>}
              </div>
              {COLS.map(c => <div key={c.key} role="cell" className="text-right tabular-nums text-[var(--ink)]">{r[c.key]}</div>)}
              <div role="cell" className="flex items-center">
                <span className="h-2 w-full overflow-hidden rounded-full bg-[var(--paper-inset)]">
                  <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round((r.total / maxTotal) * 100)}%` }} />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── 周复盘 ───

interface Insight { finding: string; strength: string | null }
interface Suggestion { action: string; why: string | null; priority: number | null }

function parseInsights(raw: string | null | undefined): Insight[] {
  const v = safeJson<unknown>(raw, []);
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : [];
  return list.flatMap(item => {
    if (typeof item === 'string') return [{ finding: item, strength: null }];
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const finding = [o.finding, o.insight, o.text, o.summary].find(x => typeof x === 'string') as string | undefined;
      return finding ? [{ finding, strength: typeof o.strength === 'string' ? o.strength : null }] : [];
    }
    return [];
  });
}

function parseSuggestions(raw: string | null | undefined): Suggestion[] {
  const v = safeJson<unknown>(raw, []);
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : [];
  const out = list.flatMap((item, i) => {
    if (typeof item === 'string') return [{ action: item, why: null, priority: i + 1 }];
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const action = [o.action, o.suggestion, o.text, o.title].find(x => typeof x === 'string') as string | undefined;
      if (!action) return [];
      const why = [o.why, o.reason].find(x => typeof x === 'string') as string | undefined;
      const p = typeof o.priority === 'number' ? o.priority : typeof o.priority === 'string' && Number.isFinite(Number(o.priority)) ? Number(o.priority) : null;
      return [{ action, why: why ?? null, priority: p }];
    }
    return [];
  });
  return out.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}

const STRENGTH_TONE: Record<string, BadgeTone> = { strong: 'success', mid: 'warning', weak: 'neutral' };

function WeeklySection({ reviews, highlightId, onChanged }: { reviews: WeeklyReview[]; highlightId: string | null; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const gen = useCareerAction();
  const generate = () => gen.run(async () => {
    const user_note = note.trim();
    await careerApi.generateWeeklyReview(user_note ? { user_note } : {});
    setNote('');
    onChanged();
  });
  const sorted = [...reviews].sort((a, b) => (b.week_start ?? '').localeCompare(a.week_start ?? '') || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return (
    <section className="space-y-3">
      <SectionTitle extra={<Button variant="primary" busy={gen.busy} onClick={() => void generate()}>生成本周复盘</Button>}>周复盘</SectionTitle>
      {gen.error && <ErrorRow message={gen.error} />}
      <Field label="想补充的情况或情绪（可选）" hint="比如这周为什么没投、哪场面试感觉不对；复盘会把它一起考虑进去">
        <TextArea aria-label="补充说明" placeholder="随便写，不用整理" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
      {sorted.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">还没有周复盘。点「生成本周复盘」，助理会按漏斗给出一件今天就能做的小事。</div>}
      <div className="space-y-3">
        {sorted.map(r => <ReviewCard key={r.id} review={r} highlighted={r.id === highlightId} />)}
      </div>
    </section>
  );
}

function ReviewCard({ review: r, highlighted }: { review: WeeklyReview; highlighted: boolean }) {
  const insights = parseInsights(r.insights_json);
  const suggestions = parseSuggestions(r.suggestions_json);
  return (
    <div id={`weekly-review-${r.id}`}>
      <Card className={highlighted ? 'ring-2 ring-[var(--accent)]' : ''} title={`${formatDate(r.week_start)} 这周`} extra={<span className="text-xs text-[var(--ink-subtle)]">生成于 {formatDate(r.created_at)}</span>}>
        {r.small_action && (
          <div className="mb-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-3 py-2">
            <div className="text-xs font-medium text-[var(--accent)]">今天就能做的一件小事</div>
            <div className="mt-0.5 text-base font-semibold text-[var(--ink)]">{r.small_action}</div>
            <div className="mt-2">
              <ChatActionButton text={`帮我做这件事：${r.small_action}`} context={{ surface: 'review', refs: { review_id: r.id } }} />
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Block title="发现">
            {insights.length === 0 && <Muted>没有新的发现。</Muted>}
            <ul className="space-y-1">
              {insights.map((it, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[var(--ink)]">
                  {it.strength && <Badge tone={STRENGTH_TONE[it.strength] ?? 'neutral'}>{STRENGTH_LABELS[it.strength as keyof typeof STRENGTH_LABELS] ?? it.strength}</Badge>}
                  <span>{it.finding}</span>
                </li>
              ))}
            </ul>
          </Block>
          <Block title="建议">
            {suggestions.length === 0 && <Muted>没有额外建议。</Muted>}
            <ol className="space-y-1">
              {suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="w-4 shrink-0 tabular-nums text-[var(--ink-subtle)]">{i + 1}.</span>
                  <div className="min-w-0">
                    <div className="text-[var(--ink)]">{s.action}</div>
                    {s.why && <div className="text-xs text-[var(--ink-muted)]">{s.why}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </Block>
        </div>
      </Card>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--ink-muted)]">{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-xs text-[var(--ink-subtle)]">{children}</div>;
}
