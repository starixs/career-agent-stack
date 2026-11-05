/**
 * 工作台页共用的视觉部件：把「多少、多深、到哪天、亮什么灯、结论是什么」画出来，而不是写成一行字。
 * 沿用产品自己的笔触（CAREER_DESIGN）：文楷大数字、带圈数字、内嵌底色的数字块、墨线描边、状态色只表状态。
 */
import { X } from 'lucide-react';
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

/** 印章：一个结论。描边加同色字，像盖在纸上的章；dashed 是推测出来的结论（虚线框）。 */
export function Stamp({ tone, children, dashed = false }: { tone: Tone; children: ReactNode; dashed?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border-[1.5px] px-2 py-0.5 font-human text-sm font-semibold ${dashed ? 'border-dashed' : ''}`}
      style={{ color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone], background: TONE_BG[tone] }}
    >
      {children}
    </span>
  );
}

/** 小标签：一块同色浅底的圆角字，不带竖杠。 */
export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center rounded-full px-2 text-xs leading-5" style={{ color: tone === 'neutral' ? 'var(--ink-2)' : TONE_COLOR[tone], background: TONE_BG[tone] }}>{children}</span>;
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

/** 分段条：几类各占多少，一眼看出哪类最多。下面一行图例带数；颜色在旁边已经有交代时用 legend={false} 只留条。 */
export function SegmentBar({ segments, label, legend = true }: { segments: Segment[]; label: string; legend?: boolean }) {
  const shown = segments.filter(segment => segment.value > 0);
  const total = shown.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return null;
  return (
    <div role="img" aria-label={`${label}：${shown.map(segment => `${segment.label} ${segment.value}`).join('，')}`}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {shown.map(segment => <span key={segment.label} style={{ flexGrow: segment.value, background: segmentColor(segment.tone) }} />)}
      </div>
      {legend && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-[var(--muted)]">
          {shown.map(segment => (
            <span key={segment.label} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: segmentColor(segment.tone) }} aria-hidden />
              {segment.label}<span className="tabular-nums text-[var(--ink-2)]">{segment.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
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

/** 点阵最多画这么多颗：再多就数不过来了，也撑破数字块。 */
const MAX_MARKS = 12;

/**
 * 点阵：一件东西一颗，颜色是它的状态，null 是还空着的（虚线）。有几件、各是什么状态一眼可数，不用读数字和图例。
 * 方的用在「条目」（一条预测一颗），圆的用在「练习」（一道题一颗）。
 */
export function Marks({ marks, shape = 'square', label }: { marks: Array<Tone | null>; shape?: 'square' | 'ring'; label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex flex-wrap items-center justify-center gap-1">
      {marks.slice(0, MAX_MARKS).map((tone, index) => (
        <span
          key={index} className={`h-3.5 w-3.5 ${shape === 'ring' ? 'rounded-full' : 'rounded-sm'} ${tone === null ? 'border-[1.5px] border-dashed border-[var(--line-2)]' : ''}`}
          style={tone === null ? undefined : { background: TONE_COLOR[tone] }}
        />
      ))}
    </span>
  );
}

/** 追问轨道：一层一个站。走过的是实心，卡住的那站是红底的叉，没走到的是虚线空圈。 */
export function DepthTrack({ total, stuck, label }: { total: number; stuck: number; label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex items-center">
      {Array.from({ length: total }, (_, index) => {
        const layer = index + 1;
        const ahead = layer > stuck;
        return (
          <span key={layer} className="flex items-center">
            {index > 0 && <span className={`w-4 border-t-[1.5px] ${ahead ? 'border-dashed border-[var(--line-2)]' : 'border-[var(--hard)]'}`} />}
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${ahead ? 'border-[1.5px] border-dashed border-[var(--line-2)] text-[var(--subtle)]' : 'text-[var(--paper)]'}`}
              style={ahead ? undefined : { background: layer === stuck ? TONE_COLOR.danger : 'var(--hard)' }}
            >
              {layer === stuck ? <X className="h-3 w-3" strokeWidth={3} /> : layer}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** 深度格最多画这么多格（技能约定追问 4–6 层）。 */
const MAX_DEPTH_BARS = 6;

/** 深度格：像信号格，一层一格、一格比一格高；颜色是这条的风险。 */
export function DepthBars({ depth, tone, label }: { depth: number; tone: Tone; label: string }) {
  const bars = Math.min(depth, MAX_DEPTH_BARS);
  if (bars <= 0) return null;
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0 items-end gap-0.5">
      {Array.from({ length: bars }, (_, index) => <span key={index} className="w-1.5 rounded-sm" style={{ height: 6 + index * 3, background: TONE_COLOR[tone] }} />)}
    </span>
  );
}

/** 练习得分到这个数算过关（题库筛选「不到 60 分」的同一条线）。 */
export const PASS_SCORE = 60;

/** 分数环：一道题练得怎样。没练过是虚线空圈，练过是带上次得分的圈，不到过关线用提醒色。 */
export function ScoreRing({ score, label }: { score: number | null; label?: string }) {
  if (score === null) return <span className="block h-8 w-8 shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--line-2)]" role="img" aria-label={label ?? '没练过'} />;
  const tone: Tone = score < PASS_SCORE ? 'warning' : 'success';
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] text-xs font-semibold tabular-nums"
      style={{ borderColor: toneColor(tone), color: toneColor(tone) }} role="img" aria-label={label ?? `上次 ${score} 分`}
    >
      {score}
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
