/**
 * 投递状态步骤条（网申 → 测评 → 笔试 → 面试 → Offer → 入职）。映射见 applicationSteps.ts。
 *
 * compact：行内一串小圆点 + 当前步骤文字；full：每步带文字的完整步骤条（hover / 展开时用）。
 * 做完的实心、当前的用状态色、没到的空心 + 虚线、跳过的虚线空心、停下的一步画 ✗（中性色，被拒不用红，见 6.1）。
 */
import { Check, X } from 'lucide-react';

import type { StepperModel, StepState, StepTone } from './applicationSteps';

const TONE_VAR: Record<StepTone, string> = {
  neutral: 'var(--muted)', info: 'var(--info)', accent: 'var(--primary)', warning: 'var(--warning)', success: 'var(--success)',
};
const STATE_TEXT: Record<StepState, string> = { done: '已完成', current: '进行中', failed: '停在这一步', skipped: '没有这一步的记录', todo: '还没到' };

function describe(model: StepperModel): string {
  return `投递进度：${model.steps.map(s => `${s.label}${STATE_TEXT[s.state]}`).join('，')}`;
}

/** 第 i 步前面的连线：已经走到（含跳过）为实线，没到为虚线。 */
function connectorReached(model: StepperModel, i: number): boolean {
  return i <= model.currentIndex;
}

function Dot({ state, tone, size }: { state: StepState; tone: StepTone; size: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-2 w-2' : 'h-[18px] w-[18px]';
  const icon = size === 'sm' ? null : 'h-3 w-3';
  if (state === 'done') {
    return (
      <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--ink-2)] text-[var(--paper)]`}>
        {icon && <Check className={icon} strokeWidth={2.5} />}
      </span>
    );
  }
  if (state === 'current') {
    const color = TONE_VAR[tone];
    return size === 'sm'
      ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 0 2px var(--bg), 0 0 0 3px ${color}` }} />
      : (
        <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full`} style={{ background: color }}>
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--paper)]" />
        </span>
      );
  }
  if (state === 'failed') {
    return (
      <span className={`${size === 'sm' ? 'h-2.5 w-2.5' : box} inline-flex shrink-0 items-center justify-center text-[var(--muted)] ${size === 'md' ? 'rounded-full border-[1.5px] border-[var(--muted)]' : ''}`}>
        <X className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.5} />
      </span>
    );
  }
  // skipped / todo：空心；跳过的用虚线边
  return <span className={`${box} shrink-0 rounded-full border-[1.5px] border-[var(--line-2)] ${state === 'skipped' ? 'border-dashed' : ''}`} />;
}

function Connector({ reached, size }: { reached: boolean; size: 'sm' | 'md' }) {
  const len = size === 'sm' ? 'w-2.5' : 'min-w-4 flex-1';
  return reached
    ? <span className={`${len} h-px shrink-0 bg-[var(--ink-2)]`} aria-hidden />
    : <span className={`${len} h-0 shrink-0 border-t border-dashed border-[var(--line-2)]`} aria-hidden />;
}

/** 行内：小圆点 + 当前步骤文字。 */
export function CompactStepper({ model }: { model: StepperModel }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" aria-label={describe(model)} role="img">
      <span className="inline-flex items-center gap-0.5" aria-hidden>
        {model.steps.map((s, i) => (
          <span key={s.key} className="inline-flex items-center gap-0.5">
            {i > 0 && <Connector reached={connectorReached(model, i)} size="sm" />}
            <Dot state={s.state} tone={model.tone} size="sm" />
          </span>
        ))}
      </span>
      <span className="text-xs font-medium" style={{ color: TONE_VAR[model.tone] }} aria-hidden>{model.label}</span>
    </span>
  );
}

/** 完整步骤条：每一步带文字。 */
export function FullStepper({ model }: { model: StepperModel }) {
  return (
    <ol className="flex w-full items-start" aria-label={describe(model)}>
      {model.steps.map((s, i) => {
        const active = s.state === 'current' || s.state === 'failed';
        const color = s.state === 'current' ? TONE_VAR[model.tone]
          : s.state === 'done' ? 'var(--ink-2)' : s.state === 'failed' ? 'var(--muted)' : 'var(--subtle)';
        return (
          <li key={s.key} className={`flex items-start ${i > 0 ? 'flex-1' : ''}`}>
            {i > 0 && <span className="mt-[9px] flex flex-1 px-1"><Connector reached={connectorReached(model, i)} size="md" /></span>}
            <span className="flex w-10 shrink-0 flex-col items-center gap-1" title={STATE_TEXT[s.state]}>
              <Dot state={s.state} tone={model.tone} size="md" />
              <span className={`whitespace-nowrap text-xs ${active ? 'font-medium' : ''}`} style={{ color }}>{s.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
