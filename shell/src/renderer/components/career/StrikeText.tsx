/**
 * 「划掉」：完成的待办画一道墨线。animate=true 时线在 300ms 内从左往右画过去，
 * 之后文字淡成已完成的颜色；已经做完的项直接显示终态。动效细节见 index.css 的 .career-strike-line。
 * 只用于单行文字（超长截断），多行时一道线画不准。
 */
import type { ReactNode } from 'react';

export function StrikeText({ done, animate = false, delayMs = 0, children, className = '' }: {
  done: boolean; animate?: boolean; children: ReactNode; className?: string;
  /** 划线前的等待（例如引导浮层里等这一行先闪入）。 */
  delayMs?: number;
}) {
  return (
    <span
      data-done={done ? 'true' : undefined}
      className={`relative inline-block max-w-full truncate align-bottom transition-colors duration-200 motion-reduce:transition-none ${done ? 'text-[var(--subtle)] delay-300 motion-reduce:delay-0' : ''} ${className}`}
    >
      {children}
      {done && (
        <span
          aria-hidden
          data-testid="strike-line"
          data-animate={animate ? 'true' : 'false'}
          style={animate && delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
          className="career-strike-line pointer-events-none absolute left-0 right-0 top-1/2 h-[1.5px] -translate-y-1/2 rounded-full bg-[var(--ink-2)]"
        />
      )}
      {done && <span className="sr-only">（已完成）</span>}
    </span>
  );
}
