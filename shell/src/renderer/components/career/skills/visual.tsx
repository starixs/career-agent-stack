/**
 * 工作台页共用的视觉部件：把「多少、多深、到哪天、亮什么灯、结论是什么」画出来，而不是写成一行字。
 * 沿用产品自己的笔触（CAREER_DESIGN）：文楷大数字、带圈数字、内嵌底色的数字块、墨线描边、状态色只表状态。
 */
import type { ReactNode } from 'react';

export type Tone = 'danger' | 'warning' | 'success' | 'info' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  danger: 'var(--danger)', warning: 'var(--warning)', success: 'var(--success)', info: 'var(--info)', neutral: 'var(--muted)',
};
const TONE_BG: Record<Tone, string> = {
  danger: 'var(--danger-bg)', warning: 'var(--warning-bg)', success: 'var(--success-bg)', info: 'var(--info-bg)', neutral: 'var(--inset)',
};

export const toneColor = (tone: Tone): string => TONE_COLOR[tone];
/** 分段条里「其余 / 还没有」那一段用淡线色，不和有含义的颜色抢。 */
const segmentColor = (tone: Tone): string => (tone === 'neutral' ? 'var(--line-2)' : TONE_COLOR[tone]);

/** 带圈数字：一条路上的第几步。 */
export function StepCircle({ n }: { n: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--hard)] font-human text-sm font-semibold text-[var(--ink)]" aria-hidden>
      {n}
    </span>
  );
}

/** 印章：一个结论。描边加同色字，像盖在纸上的章。 */
export function Stamp({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-md border-[1.5px] px-2 py-0.5 font-human text-sm font-semibold"
      style={{ color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone], background: TONE_BG[tone] }}
    >
      {children}
    </span>
  );
}

/** 大数字块：一个量和它的名字。 */
export function StatTile({ value, label, tone }: { value: ReactNode; label: string; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center rounded-lg bg-[var(--inset)] px-3 py-3">
      <span className="font-human text-2xl font-semibold tabular-nums leading-8" style={{ color: tone ? TONE_COLOR[tone] : 'var(--ink)' }}>{value}</span>
      <span className="text-xs text-[var(--muted)]">{label}</span>
    </div>
  );
}

export interface Segment { label: string; value: number; tone: Tone }

/** 分段条：几类各占多少，一眼看出哪类最多。下面一行图例带数。 */
export function SegmentBar({ segments, label }: { segments: Segment[]; label: string }) {
  const shown = segments.filter(segment => segment.value > 0);
  const total = shown.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return null;
  return (
    <div role="img" aria-label={`${label}：${shown.map(segment => `${segment.label} ${segment.value}`).join('，')}`}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {shown.map(segment => <span key={segment.label} style={{ flexGrow: segment.value, background: segmentColor(segment.tone) }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-[var(--muted)]">
        {shown.map(segment => (
          <span key={segment.label} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: segmentColor(segment.tone) }} aria-hidden />
            {segment.label}<span className="tabular-nums text-[var(--ink-2)]">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 深度圆点：一共几层、走到第几层；stuck 那一层标红，表示卡在这。 */
export function Pips({ total, reached, stuck, label }: { total: number; reached: number; stuck?: number; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, index) => {
        const layer = index + 1;
        const color = layer === stuck ? 'var(--danger)' : layer <= reached ? 'var(--ink)' : 'var(--line-2)';
        return <span key={layer} className="h-2 w-2 rounded-full" style={{ background: color }} />;
      })}
    </span>
  );
}

/** 红黄绿灯：三盏并排，亮的那一盏有颜色。 */
export function Lamps({ light, size = 'md' }: { light: string | null; size?: 'sm' | 'md' }) {
  const lamps: Array<{ id: string; color: string }> = [
    { id: 'red', color: 'var(--danger)' }, { id: 'yellow', color: 'var(--warning)' }, { id: 'green', color: 'var(--success)' },
  ];
  const dot = size === 'md' ? 'h-4 w-4' : 'h-2.5 w-2.5';
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border-[1.5px] border-[var(--hard)] bg-[var(--paper)] ${size === 'md' ? 'gap-1.5 px-2 py-1.5' : 'gap-1 px-1.5 py-1'}`} aria-hidden>
      {lamps.map(lamp => <span key={lamp.id} className={`${dot} rounded-full`} style={{ background: lamp.id === light ? lamp.color : 'var(--line)' }} />)}
    </span>
  );
}

/** 日期块：大号的日，下面小字的月。 */
export function DateBlock({ iso }: { iso: string | null }) {
  const date = iso ? new Date(iso) : null;
  const valid = !!date && !Number.isNaN(date.getTime());
  return (
    <span className="flex w-12 shrink-0 flex-col items-center">
      <span className="font-human text-2xl font-semibold tabular-nums leading-8 text-[var(--ink)]">{valid ? date.getDate() : '—'}</span>
      <span className="text-xs text-[var(--muted)]">{valid ? `${date.getMonth() + 1} 月` : '时间待定'}</span>
    </span>
  );
}

/** 离某天还有几天（按天算，当天是 0）；没有日期或解析不了返回 null。 */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((start(date) - start(now)) / 86_400_000);
}
