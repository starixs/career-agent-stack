/**
 * 对话里的「我的求职月」卡（month_review）：想复盘、问投递效果时出现。只放本月四个数，整张卡点一下就到漏斗那页；
 * 复盘本身在那页做，对话里不展开（2026-10-30 周复盘功能删掉，复盘只看「我的求职月」）。
 */
import { requestNavigation } from '@/features/career-shell/navModel';

import { LAYER_COLORS, LAYER_NAMES } from './monthFunnelGeometry';

type Counts = [number, number, number, number];

export function MonthReviewCard({ title, counts, prev }: { title: string; counts: Counts; prev: Counts | null }) {
  return (
    <button
      type="button"
      data-testid="career-card-month_review"
      onClick={() => requestNavigation({ kind: 'career-review' })}
      className="w-full max-w-md rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-left transition-colors hover:border-[var(--line-2)]"
    >
      <div className="text-sm font-medium text-[var(--ink)]">{title}</div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {LAYER_NAMES.map((name, k) => (
          <div key={name}>
            <div className="text-xl font-semibold tabular-nums" style={{ color: LAYER_COLORS[k] }}>{counts[k]}</div>
            <div className="text-xs text-[var(--muted)]">{name}{prev ? ` · 上月 ${prev[k]}` : ''}</div>
          </div>
        ))}
      </div>
    </button>
  );
}

export function isCounts(v: unknown): v is Counts {
  return Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number');
}
