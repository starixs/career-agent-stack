/**
 * 累计漏斗（投出之后）：每层一根居中的横条，层间写转化率。悬停或键盘聚焦弹出这一层的详情与总结，点击钉住。
 * 只有一个数据系列，所以条形统一用钢笔蓝；悬停时其余层退后（见 dataviz 的「强调一个、其余灰掉」）。
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/career/CareerPrimitives';
import type { FunnelLayerKey, ReviewFunnelLayer } from '@/components/career/types';

import { openApplications, percent } from './reviewLinks';

export const LAYER_LABELS: Record<FunnelLayerKey, string> = { applied: '已投递', responded: '有回应', interview: '面试', offer: 'Offer' };

/** 停在这一层的去向。颜色只是辅助，图例里每段都有文字和数字。 */
const OUTCOMES: Array<{ key: 'forward' | keyof ReviewFunnelLayer['stopped']; label: (l: FunnelLayerKey) => string; color: string }> = [
  { key: 'forward', label: () => '走到下一层', color: 'var(--primary)' },
  { key: 'hired', label: () => '已入职', color: 'var(--success)' },
  { key: 'waiting', label: l => (l === 'offer' ? '待你决定' : '还在等'), color: 'var(--primary-muted)' },
  { key: 'silent', label: () => '沉默', color: 'var(--line-2)' },
  { key: 'rejected', label: () => '被拒', color: 'var(--muted)' },
  { key: 'discarded', label: () => '主动放弃', color: 'var(--line)' },
];

export function ReviewFunnelChart({ layers }: { layers: ReviewFunnelLayer[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = pinned ?? hovered;
  const max = Math.max(1, ...layers.map(l => l.n));

  // 钉住后点外面或按 Esc 收起
  useEffect(() => {
    if (pinned === null) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setPinned(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(null); setHovered(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [pinned]);

  return (
    <div ref={rootRef} className="space-y-0.5" aria-label="累计漏斗">
      {layers.map((l, k) => {
        const width = l.n > 0 ? Math.max(3, (l.n / max) * 100) : 0;
        const dim = shown !== null && shown !== k;
        return (
          <div key={l.layer}>
            {k > 0 && (
              <div className="grid grid-cols-[72px_1fr_112px] text-xs text-[var(--subtle)]" aria-hidden>
                <span />
                <span className="py-0.5 text-center tabular-nums">↓ {percent(l.rate)}</span>
                <span />
              </div>
            )}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={shown === k}
              aria-label={`${LAYER_LABELS[l.layer]} ${l.n} 条${k > 0 ? `，上一层的 ${percent(l.rate)}` : ''}`}
              className="relative grid cursor-pointer grid-cols-[72px_1fr_112px] items-center rounded-[var(--radius-md)] py-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              onMouseEnter={() => setHovered(k)}
              onMouseLeave={() => setHovered(h => (h === k ? null : h))}
              onFocus={() => setHovered(k)}
              onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(h => (h === k ? null : h)); }}
              onClick={() => setPinned(p => (p === k ? null : k))}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned(p => (p === k ? null : k)); } }}
            >
              <span className="text-sm text-[var(--ink-2)]">{LAYER_LABELS[l.layer]}</span>
              <span className="flex h-6 justify-center">
                <span
                  className="h-6 rounded-[var(--radius-sm)] transition-opacity duration-[var(--motion-fast)]"
                  style={{ width: `${width}%`, background: 'var(--primary)', opacity: dim ? 0.35 : 1 }}
                />
              </span>
              <span className="flex items-baseline justify-end gap-2 text-right">
                <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">{l.n}</span>
                {l.new_this_week > 0 && <span className="text-xs tabular-nums text-[var(--muted)]">本周 +{l.new_this_week}</span>}
              </span>
              {shown === k && <LayerPopover layer={l} index={k} widthPct={width} pinned={pinned === k} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LayerPopover({ layer: l, index, widthPct, pinned }: { layer: ReviewFunnelLayer; index: number; widthPct: number; pinned: boolean }) {
  const forward = l.n - Object.values(l.stopped).reduce((s, v) => s + v, 0);
  const parts = OUTCOMES.map(o => ({ ...o, n: o.key === 'forward' ? forward : l.stopped[o.key] })).filter(p => p.n > 0);
  // 贴在条形右端外侧；放不下时靠右对齐
  const left = `min(calc(72px + (100% - 184px) * ${(50 + widthPct / 2) / 100} + 12px), calc(100% - 20rem))`;
  return (
    <div
      role="dialog"
      aria-label={`${LAYER_LABELS[l.layer]}详情`}
      className="absolute top-0 z-[50] w-80 cursor-default rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] p-3 text-left shadow-[var(--shadow-md)]"
      style={{ left }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--ink)]">{LAYER_LABELS[l.layer]} · {l.n} 条</span>
        <span className="text-xs text-[var(--muted)]">{index > 0 ? `上一层的 ${percent(l.rate)}` : '累计'}{pinned ? ' · 已钉住' : ''}</span>
      </div>
      {parts.length > 0 && (
        <>
          <div className="mt-2 flex h-2 gap-[2px] overflow-hidden rounded-[var(--radius-sm)]" aria-hidden>
            {parts.map(p => <span key={p.key} style={{ flexGrow: p.n, background: p.color }} />)}
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs" aria-label="去向">
            {parts.map(p => (
              <li key={p.key} className="flex items-center gap-1.5 text-[var(--ink-2)]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                <span>{p.label(l.layer)}</span>
                <span className="ml-auto tabular-nums text-[var(--ink)]">{p.n}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-sm leading-[22px] text-[var(--ink-2)]">{l.summary}</p>
      {l.n > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openApplications(`漏斗 · 走到${LAYER_LABELS[l.layer]}`, l.application_ids)}>在投递记录里看这 {l.n} 条</Button>
          {l.silent_ids.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => openApplications(`漏斗 · 停在${LAYER_LABELS[l.layer]}且已沉默`, l.silent_ids)}>只看沉默的 {l.silent_ids.length} 条</Button>
          )}
        </div>
      )}
    </div>
  );
}
