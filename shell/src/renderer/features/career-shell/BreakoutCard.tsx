/**
 * 对话内工作面的收起态（specs/CAREER_DESIGN.md §5.7）：「打破式」卡片。
 *
 * 平时没有外框、底色和投影，直接排在对话背景上，靠视觉锚和文楷标题跟普通回复拉开；
 * hover 时纸面轻微抬起、阴影加深，「打开 XX」变成实按钮。所有工作面共用这一套语法：
 * 左边一个视觉锚，右边主名称 + 次级标注 + 正文 + 键值行，状态只在右上角。
 */
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

export type BreakoutTone = 'running' | 'waiting' | 'idle' | 'error';

const TONE: Record<BreakoutTone, { dot: string; chip: string }> = {
  running: { dot: 'bg-[var(--success)]', chip: 'bg-[var(--success-bg)] text-[var(--success)]' },
  waiting: { dot: 'bg-[var(--warning)]', chip: 'bg-[var(--warning-bg)] text-[var(--warning)]' },
  idle: { dot: 'bg-[var(--subtle)]', chip: 'bg-[var(--inset)] text-[var(--muted)]' },
  error: { dot: 'bg-[var(--danger)]', chip: 'bg-[var(--danger-bg)] text-[var(--danger)]' },
};

export interface BreakoutRow { label: string; value: ReactNode }

export function BreakoutCard({ testId, anchor, title, aside, overline, children, rows, status, action, open }: {
  testId: string;
  anchor: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  overline?: ReactNode;
  /** 正文：一段说明、一道题、一条前后对比。 */
  children?: ReactNode;
  rows?: readonly BreakoutRow[];
  status: { tone: BreakoutTone; text: string };
  action: { label: string; onOpen: () => void; disabled?: boolean };
  /** 工作面已在右侧展开：按钮弱化成「已在右侧打开 →」，卡片不再抬起。 */
  open?: boolean;
}) {
  const tone = TONE[status.tone];
  const interactive = !open && !action.disabled;
  const visibleRows = (rows ?? []).filter(row => row.value !== null && row.value !== undefined && row.value !== '');
  return (
    <div
      data-testid={testId}
      onClick={interactive ? action.onOpen : undefined}
      className={`group relative -mx-3 max-w-[640px] rounded-[10px] px-3 py-3 transition-[background-color,box-shadow,transform] duration-200 ${interactive
        ? 'cursor-pointer hover:-translate-y-0.5 hover:bg-[var(--paper)] hover:shadow-md focus-within:bg-[var(--paper)] focus-within:shadow-md'
        : ''}`}
    >
      <div className="flex gap-5">
        <div className="shrink-0">{anchor}</div>
        <div className="min-w-0 flex-1 pr-28">
          <div className="font-human text-xl font-semibold leading-tight text-[var(--ink)]">
            {title}
            {aside && <span className="ml-2 font-sans text-sm font-normal text-[var(--subtle)]">{aside}</span>}
          </div>
          {overline && <div className="mt-1.5 text-xs tracking-[0.12em] text-[var(--muted)]">{overline}</div>}
          {children && <div className="mt-2.5 text-sm leading-relaxed text-[var(--ink-2)]">{children}</div>}
          {visibleRows.length > 0 && (
            <dl className="mt-3 grid grid-cols-[4rem_minmax(0,1fr)] gap-y-1 border-t border-[var(--line)] pt-2.5 text-sm text-[var(--ink)]">
              {visibleRows.map(row => (
                <div key={row.label} className="contents">
                  <dt className="pt-px text-xs tracking-[0.14em] text-[var(--subtle)]">{row.label}</dt>
                  <dd className="min-w-0 truncate">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <div className={`absolute right-3 top-3 flex max-w-[40%] items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${tone.chip}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
        <span className="truncate">{status.text}</span>
      </div>
      <div className="mt-3 flex justify-end">
        {open ? (
          <span className="text-sm text-[var(--muted)]">已在右侧打开 →</span>
        ) : (
          <button
            type="button"
            disabled={action.disabled}
            className="flex h-8 items-center gap-1.5 rounded-md border-[1.5px] border-transparent px-3 text-sm font-semibold text-[var(--primary)] transition-[border-color,box-shadow,color] duration-200 group-hover:border-[var(--hard)] group-hover:bg-[var(--paper)] group-hover:text-[var(--ink)] group-hover:shadow-hard focus-visible:border-[var(--hard)] focus-visible:shadow-hard disabled:cursor-not-allowed disabled:opacity-60"
          >
            {action.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 视觉锚：每张卡只有一个 ───

/** 一张文档页的缩略：简历、导出的文件。 */
export function PageAnchor() {
  return (
    <div aria-hidden="true" className="flex h-[92px] w-[70px] flex-col gap-1.5 rounded-[3px] border border-[var(--line-2)] bg-[var(--paper)] px-2 py-2.5 shadow-[3px_3px_0_var(--selected)]">
      <div className="h-1.5 w-3/5 rounded-sm bg-[var(--ink-2)]" />
      <div className="h-[3px] bg-[var(--line-2)]" />
      <div className="h-[3px] bg-[var(--line-2)]" />
      <div className="h-[3px] w-4/5 bg-[var(--line-2)]" />
      <div className="mt-1 h-1 w-2/5 bg-[var(--subtle)]" />
      <div className="h-[3px] bg-[var(--line-2)]" />
      <div className="h-[3px] w-3/4 bg-[var(--line-2)]" />
    </div>
  );
}

/** 首字方块：人（简历姓名）用浅底，机构（公司）用 `solid` 深底。 */
export function InitialAnchor({ text, solid = false }: { text: string; solid?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center font-human font-bold ${solid
        ? 'h-[70px] w-[70px] rounded-md bg-[var(--ink)] text-3xl text-[var(--bg)]'
        : 'h-[92px] w-[78px] rounded-[4px] bg-[var(--selected)] text-4xl text-[var(--ink-2)]'}`}
    >
      {Array.from(text.trim())[0] ?? '·'}
    </span>
  );
}

/** 日历日期块：月 / 日 / 星期。 */
export function DateAnchor({ value }: { value: string | null }) {
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return (
    <div className="w-[70px] overflow-hidden rounded-md border-[1.5px] border-[var(--hard)] text-center" aria-label={valid ? date.toLocaleDateString('zh-CN') : '日期未定'}>
      <div className="bg-[var(--seal)] py-0.5 text-xs font-semibold text-white">{valid ? `${date.getMonth() + 1} 月` : '待定'}</div>
      <div className="font-human text-3xl font-bold leading-tight text-[var(--ink)]">{valid ? date.getDate() : '—'}</div>
      <div className="pb-1 text-xs text-[var(--muted)]">{valid ? `周${'日一二三四五六'[date.getDay()]}` : ''}</div>
    </div>
  );
}

export type StepState = 'done' | 'current' | 'todo' | 'failed';

/** 横向状态步骤条（物流 / 网申进度那种）：投递记录和网申浏览器共用。 */
export function StepBar({ steps }: { steps: ReadonlyArray<{ label: string; state: StepState }> }) {
  return (
    <ol className="flex items-start">
      {steps.map((step, i) => (
        <li key={step.label} className="flex min-w-0 flex-1 items-start last:flex-none">
          <div className="flex w-14 flex-col items-center gap-1.5 text-center">
            <span
              className={`grid h-[18px] w-[18px] place-items-center rounded-full text-xs ${step.state === 'done'
                ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                : step.state === 'current'
                  ? 'border-2 border-[var(--warning)] bg-[var(--warning-bg)]'
                  : step.state === 'failed'
                    ? 'bg-[var(--danger)] text-white'
                    : 'border-2 border-[var(--line-2)]'}`}
              aria-hidden="true"
            >
              {step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : ''}
            </span>
            <span className={`text-xs leading-tight ${step.state === 'current' ? 'font-semibold text-[var(--warning)]' : step.state === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}`}>
              {step.label}
              {step.state !== 'todo' && <span className="sr-only">（{step.state === 'done' ? '已完成' : step.state === 'current' ? '进行中' : '失败'}）</span>}
            </span>
          </div>
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`mt-2 h-0.5 min-w-3 flex-1 ${step.state === 'done' ? 'bg-[var(--primary)]' : 'bg-[repeating-linear-gradient(90deg,var(--line-2)_0_4px,transparent_4px_8px)]'}`}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/** 一个大数字：改了几处、几个岗位。 */
export function CountAnchor({ value, unit }: { value: number; unit: string }) {
  return (
    <div className="w-[70px]">
      <div className="font-human text-6xl font-bold leading-none text-[var(--primary)] tabular-nums">{value}</div>
      <div className="mt-1.5 text-xs tracking-[0.12em] text-[var(--muted)]">{unit}</div>
    </div>
  );
}

/** 已答 / 总数，加一排进度格。 */
export function ProgressAnchor({ done, total }: { done: number; total: number }) {
  const cells = Math.min(Math.max(total, 0), 20);
  return (
    <div className="w-[90px]" aria-label={`已答 ${done} / ${total}`}>
      <div className="font-human text-5xl font-bold leading-none text-[var(--ink)] tabular-nums">
        {done}<span className="text-2xl text-[var(--subtle)]">/{total}</span>
      </div>
      {cells > 0 && (
        <div className="mt-3 grid grid-cols-5 gap-1" aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => (
            <div key={i} className={`h-2 rounded-sm ${i < done ? 'bg-[var(--primary)]' : 'bg-[var(--line-2)]'}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export type RailState = 'done' | 'current' | 'todo';

/** 竖排阶段轨道：答过的实心，正在进行的黄圈，没到的灰色虚线。 */
export function RailAnchor({ stages }: { stages: ReadonlyArray<{ label: string; state: RailState }> }) {
  return (
    <ol className="w-[90px]">
      {stages.map((stage, i) => (
        <li key={stage.label} className="flex gap-2.5">
          <div className="flex w-5 flex-col items-center">
            <span
              aria-hidden="true"
              className={stage.state === 'current'
                ? 'h-5 w-5 rounded-full border-[3px] border-[var(--warning)] bg-[var(--warning-bg)]'
                : stage.state === 'done'
                  ? 'mt-0.5 h-3.5 w-3.5 rounded-full bg-[var(--primary)]'
                  : 'mt-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--line-2)]'}
            />
            {i < stages.length - 1 && (
              <span
                aria-hidden="true"
                className={`my-1 h-5 w-0.5 ${stages[i + 1].state === 'todo' ? 'bg-[repeating-linear-gradient(180deg,var(--line-2)_0_4px,transparent_4px_8px)]' : 'bg-[var(--primary)]'}`}
              />
            )}
          </div>
          <span className={`pt-0.5 text-xs ${stage.state === 'current' ? 'font-semibold text-[var(--warning)]' : 'text-[var(--subtle)]'}`}>
            {stage.label}
            {stage.state === 'current' && <span className="sr-only">（进行中）</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
