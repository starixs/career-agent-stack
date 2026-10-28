/**
 * 我的求职月：复盘页，只回看已经发生的事（推进任务归通知中心和日历页）。
 * 顶部五个数（本月四层 + 用我们以来替你投出）→ 花瓶漏斗与过往月份年轮（悬停才出面板）→ 每一天的投递后来怎么样了 → 周复盘。
 * 口径见 packages/core/src/review-board.ts。视图：我的求职月 / 调研与方向（嵌入 CareerResearch）。
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
import { QuoteNote } from '@/components/career/handwriting/QuoteNote';
import { LayerPanel } from '@/components/career/review/LayerPanel';
import { MonthDays } from '@/components/career/review/MonthDays';
import { MonthFunnel } from '@/components/career/review/MonthFunnel';
import { monthQuoteScene } from '@/components/career/review/monthQuoteScene';
import { LAYER_COLORS, LAYER_NAMES } from '@/components/career/review/monthFunnelGeometry';
import type { CareerFocusEvent, MonthBoard, WeeklyReview } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { DEFAULT_SUB_VIEWS } from '@/features/career-shell/navModel';
import { useCareerSubView } from '@/features/career-shell/subViewStore';

const CareerResearch = lazy(() => import('@/pages/CareerResearch'));

// 子视图由功能市场的入口选择（features/career-shell），页面本身不再放切换控件。
type View = 'funnel' | 'research';
const VIEW_HEADINGS: Record<View, { title: string; subtitle: string }> = {
  funnel: { title: '我的求职月', subtitle: '这个月走了多远' },
  research: { title: '公司调研与方向', subtitle: '投之前先看一眼，也看看还有哪些方向适合你' },
};

export default function CareerReview({ embedded = false }: CareerPageProps) {
  const [view, setView] = useCareerSubView<View>('career-review', DEFAULT_SUB_VIEWS['career-review']);
  const [focusId, setFocusId] = useState<string | null>(null);
  // 看哪个月（YYYY-MM）；null = 本月。
  const [month, setMonth] = useState<string | null>(null);
  const query = useCareerQuery(() => careerApi.review(month ?? undefined), ['application', 'application_history', 'weekly_review', 'job', 'deadline', 'interview', 'offer', 'action_queue']);
  const reload = query.reload;
  const changeMonth = (next: string | null) => { setMonth(next); reload(); };
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
          {data && <MonthSection board={data.board} onMonth={changeMonth} />}
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

// ─── 我的求职月 ───

function MonthSection({ board, onMonth }: { board: MonthBoard | null; onMonth: (month: string | null) => void }) {
  // 面板平时留白：悬停某一层才出现，点击钉住；离开漏斗和面板所在的区域回到钉住的那层（没钉就留白）
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  if (!board) return null;
  if (board.month.is_current && !board.month.prev_key && board.counts.every((c) => c === 0)) {
    return (
      <section>
        <EmptyState title="还没有投递。投出去之后，这里会长出这个月的漏斗。" />
        <QuoteNote scene="funnel-start" pick="random" className="mb-4 text-center text-xl" />
        <div className="flex justify-center">
          <ChatActionButton text="帮我看看接下来该投什么" context={{ surface: 'review' }} />
        </div>
      </section>
    );
  }
  const layer = hovered ?? pinned;
  const { counts, prev } = board;
  return (
    <>
      <div className="flex items-center gap-1 text-sm">
        <Button size="sm" variant="ghost" aria-label="上个月" disabled={!board.month.prev_key} onClick={() => onMonth(board.month.prev_key)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
        <span className="font-semibold tabular-nums text-[var(--ink)]" aria-live="polite">{board.month.year} 年 {board.month.month} 月</span>
        <Button size="sm" variant="ghost" aria-label="下个月" disabled={!board.month.next_key} onClick={() => onMonth(board.month.next_key)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
      </div>
      {/* 按这个月走到哪一步，手写一句（每次打开随机，不与上次重复）。 */}
      <QuoteNote scene={monthQuoteScene(board)} pick="random" className="text-xl" />

      <dl className="flex flex-wrap items-end gap-x-20 gap-y-6" aria-label="本月关键数字">
        {LAYER_NAMES.map((name, k) => (
          <BigNumber key={name} label={name} value={counts[k]} dot={LAYER_COLORS[k]} foot={prev ? `上月 ${prev[k]}` : '\u00a0'} />
        ))}
        <div className="ml-auto border-l-[1.5px] border-dashed border-[var(--line-2)] pl-11">
          <BigNumber label="用我们以来 · 替你投出" value={board.since_total} accent foot={'\u00a0'} />
        </div>
      </dl>

      <section aria-label="本月漏斗" className="flex items-stretch gap-12" onMouseLeave={() => setHovered(null)}>
        <MonthFunnel board={board} layer={layer} onHover={setHovered} onPin={(k) => setPinned((p) => (p === k ? null : k))} />
        <div className="min-h-[440px] min-w-0 flex-1 pl-11">
          {layer !== null && <LayerPanel board={board} layer={layer} />}
        </div>
      </section>

      <MonthDays board={board} layer={layer} />
    </>
  );
}

function BigNumber({ label, value, dot, foot, accent = false }: { label: string; value: number; dot?: string; foot: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-[var(--subtle)]">
        {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden />}
        {label}
      </dt>
      <dd className="m-0 font-black" style={{ fontSize: 76, lineHeight: '80px', color: accent ? 'var(--primary)' : 'var(--ink)' }} aria-label={`${label} ${value}`}>{value}</dd>
      <dd className="m-0 text-xs text-[var(--subtle)]">{foot}</dd>
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
