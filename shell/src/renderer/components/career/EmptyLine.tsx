/**
 * 页内分区为空时折成一行：分区名 + 「—」+ 一个动词按钮（§3.4：空态 = 一句事实 + 一个动作）。
 * 用在一页有好几块的地方（面试、公司调研），避免每块都摆一个居中的大空态。
 */
import type { ReactNode } from 'react';

import { EMPTY_VALUE } from './CareerPrimitives';

export function EmptyLine({ label, action }: { label: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[38px] items-center gap-3 border-b border-[var(--line)] py-1 text-sm">
      <span className="w-28 shrink-0 text-[var(--ink-2)]">{label}</span>
      <span className="text-[var(--subtle)]">{EMPTY_VALUE}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}
