/**
 * 我的求职月：复盘页，只回看已经发生的事（推进任务归通知中心和日历页）。
 * 顶部五个数（本月四层 + 用我们以来替你投出）→ 花瓶漏斗与过往月份年轮（悬停才出面板）→ 每一天的投递后来怎么样了 → 页底手写一句。
 * 口径见 packages/core/src/review-board.ts。视图：我的求职月 / 调研与方向（嵌入 CareerResearch）。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { onEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { Button, CareerPage, ErrorRow, LoadingRow } from '@/components/career/CareerPrimitives';
import { QuoteNote } from '@/components/career/handwriting/QuoteNote';
import { LayerPanel } from '@/components/career/review/LayerPanel';
import { MonthDays } from '@/components/career/review/MonthDays';
import { MonthFunnel } from '@/components/career/review/MonthFunnel';
import { monthQuoteScene } from '@/components/career/review/monthQuoteScene';
import { LAYER_COLORS, LAYER_NAMES } from '@/components/career/review/monthFunnelGeometry';
import type { CareerFocusEvent, MonthBoard } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
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
  // 看哪个月（YYYY-MM）；null = 本月。
  const [month, setMonth] = useState<string | null>(null);
  const query = useCareerQuery(() => careerApi.review(month ?? undefined), ['application', 'application_history', 'job', 'deadline', 'interview', 'offer', 'action_queue']);
  const reload = query.reload;
  const changeMonth = (next: string | null) => { setMonth(next); reload(); };
  const data = query.data;

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'review') return;
    setView('funnel');
  }), [setView]);

  return (
    <CareerPage
      embedded={embedded}
      title={VIEW_HEADINGS[view].title}
      subtitle={VIEW_HEADINGS[view].subtitle}
    >
      {view === 'funnel' && (
        <div className="space-y-6 px-6 py-4">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !data && <LoadingRow />}
          {data && <MonthSection board={data.board} onMonth={changeMonth} />}
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
  // 还没投出时漏斗摆标准初始形状（见 MonthFunnel），不再单独做空状态页
  if (!board) return null;
  const layer = hovered ?? pinned;
  const { counts, prev } = board;
  return (
    <>
      <div className="flex items-center gap-1 text-sm">
        <Button size="sm" variant="ghost" aria-label="上个月" disabled={!board.month.prev_key} onClick={() => onMonth(board.month.prev_key)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
        <span className="font-semibold tabular-nums text-[var(--ink)]" aria-live="polite">{board.month.year} 年 {board.month.month} 月</span>
        <Button size="sm" variant="ghost" aria-label="下个月" disabled={!board.month.next_key} onClick={() => onMonth(board.month.next_key)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
      </div>

      <dl className="flex items-end gap-x-14" aria-label="本月关键数字">
        {LAYER_NAMES.map((name, k) => (
          <BigNumber key={name} label={name} value={counts[k]} dot={LAYER_COLORS[k]} foot={prev ? `上月 ${prev[k]}` : '\u00a0'} />
        ))}
        {/* 这个月的手写一句，放在四个数和「替你投出」之间的留白里（按走到哪一步选句，每次打开随机、不与上次重复）。 */}
        <div className="flex min-w-0 flex-1 items-center justify-end self-center">
          {/* eslint-disable-next-line no-restricted-syntax -- 展示型字号 30px 已在 specs/CAREER_DESIGN.md 7.7 立档：和 56px 的大数字同一行，要压得住又不抢 */}
          <QuoteNote scene={monthQuoteScene(board)} pick="random" className="text-right text-[30px]" />
        </div>
        <div className="border-l-[1.5px] border-dashed border-[var(--line-2)] pl-10">
          <BigNumber label="用我们以来 · 替你投出" value={board.since_total} accent foot={'\u00a0'} />
        </div>
      </dl>

      <section aria-label="本月漏斗" className="flex items-stretch gap-10" onMouseLeave={() => setHovered(null)}>
        <MonthFunnel board={board} layer={layer} onHover={setHovered} onPin={(k) => setPinned((p) => (p === k ? null : k))} />
        <div className="min-h-[330px] min-w-0 flex-1 pl-8">
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
      <dd className="m-0 font-black" style={{ fontSize: 56, lineHeight: '60px', color: accent ? 'var(--primary)' : 'var(--ink)' }} aria-label={`${label} ${value}`}>{value}</dd>
      <dd className="m-0 text-xs text-[var(--subtle)]">{foot}</dd>
    </div>
  );
}
