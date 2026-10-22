/**
 * 复盘：每周一次，用数字代替猜测。顶部关键数字 + 累计漏斗（投出之后，对方的反馈）+ 本周甘特（有截止的事，自己的完成情况）
 * + 周复盘（一件今天就能做的小事）。漏斗与甘特分工见 packages/core/src/review-board.ts。
 * 视图：漏斗与周复盘（新）/ 调研与方向（嵌入 CareerResearch）。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { onEvent } from '@/api/eventBus';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { STRENGTH_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, ChatActionButton, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, TextArea, formatDate,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import { ReviewFunnelChart } from '@/components/career/review/ReviewFunnelChart';
import { ReviewWeekGantt } from '@/components/career/review/ReviewWeekGantt';
import { addDays, percent, shortDate } from '@/components/career/review/reviewLinks';
import type { CareerFocusEvent, ReviewBoard, WeeklyReview } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { DEFAULT_SUB_VIEWS } from '@/features/career-shell/navModel';
import { useCareerSubView } from '@/features/career-shell/subViewStore';

const CareerResearch = lazy(() => import('@/pages/CareerResearch'));

// 子视图由功能市场的入口选择（features/career-shell），页面本身不再放切换控件。
type View = 'funnel' | 'research';
const VIEW_HEADINGS: Record<View, { title: string; subtitle: string }> = {
  funnel: { title: '求职漏斗与周复盘', subtitle: '每周一次，用数字代替猜测' },
  research: { title: '公司调研与方向', subtitle: '投之前先看一眼，也看看还有哪些方向适合你' },
};

export default function CareerReview({ embedded = false }: CareerPageProps) {
  const [view, setView] = useCareerSubView<View>('career-review', DEFAULT_SUB_VIEWS['career-review']);
  const [focusId, setFocusId] = useState<string | null>(null);
  // 看哪一周（周一日期）；null = 本周。看板的周数字和甘特跟着变，漏斗始终是累计。
  const [week, setWeek] = useState<string | null>(null);
  const query = useCareerQuery(() => careerApi.review(week ?? undefined), ['application', 'application_history', 'weekly_review', 'job', 'deadline', 'interview']);
  const reload = query.reload;
  const changeWeek = (next: string | null) => { setWeek(next); reload(); };
  const data = query.data;

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'review') return;
    setView('funnel');
    if (payload.id) setFocusId(payload.id);
  }), [setView]);

  // 只对同一个焦点滚动一次；用户手动切视图即清除高亮。
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || !data || scrolledFor.current === focusId) return;
    const el = document.getElementById(`weekly-review-${focusId}`);
    if (!el) return;
    scrolledFor.current = focusId;
    el.scrollIntoView?.({ block: 'start' });
  }, [focusId, data]);

  return (
    <CareerPage
      embedded={embedded}
      title={VIEW_HEADINGS[view].title}
      subtitle={VIEW_HEADINGS[view].subtitle}
    >
      {view === 'funnel' && (
        <div className="space-y-8 px-6 py-4">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !data && <LoadingRow />}
          {data && <BoardSection board={data.board} week={week} onWeek={changeWeek} />}
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

// ─── 本周看板：顶部数字 + 累计漏斗 + 本周甘特 ───

function BoardSection({ board, week, onWeek }: { board: ReviewBoard | null; week: string | null; onWeek: (week: string | null) => void }) {
  if (!board) return null;
  const empty = board.funnel[0].n === 0 && board.gantt.length === 0 && board.undated.length === 0;
  if (empty && board.week.is_current) {
    return (
      <section>
        <EmptyState title="还没有投递数据。先在收件箱丢几个 JD，投出去之后这里会出现漏斗。" />
        <div className="flex justify-center">
          <ChatActionButton text="帮我看看接下来该投什么" context={{ surface: 'review' }} />
        </div>
      </section>
    );
  }
  const k = board.kpis;
  const delta = k.applied - k.applied_prev;
  const prevLabel = board.week.is_current ? '上周' : '前一周';
  const lastDay = board.week.days[6];
  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" aria-label="上一周" onClick={() => onWeek(addDays(board.week.start, -7))}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
          <span className="text-sm font-medium tabular-nums text-[var(--ink)]" aria-live="polite">
            {shortDate(board.week.start)} – {shortDate(lastDay)}{board.week.is_current ? ' · 本周' : ''}
          </span>
          <Button size="sm" variant="ghost" aria-label="下一周" disabled={board.week.is_current} onClick={() => onWeek(addDays(board.week.start, 7))}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
          {week && !board.week.is_current && <Button size="sm" variant="ghost" onClick={() => onWeek(null)}>回到本周</Button>}
        </div>
        <dl className="flex flex-wrap gap-x-10 gap-y-4" aria-label="关键数字">
          <Stat label="投出" value={k.applied} note={delta === 0 ? `和${prevLabel}一样` : `比${prevLabel}${delta > 0 ? '多' : '少'} ${Math.abs(delta)}`} />
          <Stat label="新回应" value={k.responded} note="第一次有回音的投递" />
          <Stat label="面试" value={k.interviews} note="这周排上的面试" />
          <Stat
            label="到期事项完成"
            value={k.due > 0 ? `${k.done}/${k.due}` : '—'}
            note={k.missed > 0 ? `错过 ${k.missed} 件` : k.due > 0 ? '没有错过' : '还没有到期的事'}
            noteTone={k.missed > 0 ? 'danger' : undefined}
          />
          <Stat label="累计回应率" value={percent(k.response_rate)} note="有回应 / 已投递" />
        </dl>
      </section>

      <section className="space-y-2">
        <SectionTitle extra={<span className="text-xs text-[var(--muted)]">累计 · 悬停看每一层的去向，点击钉住</span>}>投出之后走到了哪</SectionTitle>
        <ReviewFunnelChart layers={board.funnel} />
        <p className="text-xs text-[var(--subtle)]">经验上网申过简历率通常只有一到两成，沉默比被拒常见；这不是能力结论。</p>
      </section>

      <section className="space-y-2">
        <SectionTitle extra={<span className="text-xs text-[var(--muted)]">{board.week.is_current ? '本周' : '所选这周'} · 点一行看对应投递</span>}>这周的事做完了没</SectionTitle>
        <div className="overflow-x-auto">
          <ReviewWeekGantt board={board} />
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, note, noteTone }: { label: string; value: number | string; note: string; noteTone?: 'danger' }) {
  return (
    <div className="min-w-[88px]">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="text-3xl font-semibold text-[var(--ink)]" aria-label={`${label} ${value}`}>{value}</dd>
      <dd className={`text-xs ${noteTone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}`}>{note}</dd>
    </div>
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
      {sorted.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有周复盘。点「生成本周复盘」，助理会按漏斗给出一件今天就能做的小事。</div>}
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
      <Card className={highlighted ? 'ring-2 ring-[var(--primary)]' : ''} title={`${formatDate(r.week_start)} 这周`} extra={<span className="text-xs text-[var(--subtle)]">生成于 {formatDate(r.created_at)}</span>}>
        {r.small_action && (
          <div className="mb-3 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-3 py-2">
            <div className="text-xs font-medium text-[var(--primary)]">今天就能做的一件小事</div>
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
                  <span className="w-4 shrink-0 tabular-nums text-[var(--subtle)]">{i + 1}.</span>
                  <div className="min-w-0">
                    <div className="text-[var(--ink)]">{s.action}</div>
                    {s.why && <div className="text-xs text-[var(--muted)]">{s.why}</div>}
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
      <div className="mb-1 text-xs font-medium text-[var(--muted)]">{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-xs text-[var(--subtle)]">{children}</div>;
}
