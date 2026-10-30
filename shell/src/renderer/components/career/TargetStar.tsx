/**
 * 目标岗位的星：用户亲手标 / 取消；进过面试的自动算目标（实心、不能取消）。
 * 没标的只在行悬停时露出空心星（动作悬停才出现），系统不替用户点亮。
 */
import { Star } from 'lucide-react';

import { careerApi } from './careerApi';
import { useCareerAction } from './useCareerData';

export function TargetStar({ jobId, source, label, onChanged }: { jobId: string; source: 'interview' | 'user' | null | undefined; label: string; onChanged?: () => void }) {
  const action = useCareerAction();
  const lit = source === 'interview' || source === 'user';
  const auto = source === 'interview';
  const title = auto ? '进过面试，自动算目标' : lit ? '取消目标' : '标成目标岗位，重点打磨';
  const toggle = () => void action.run(async () => { await careerApi.setJobTarget(jobId, !lit); onChanged?.(); });
  return (
    <button
      type="button"
      aria-label={`${title}：${label}`}
      aria-pressed={lit}
      title={action.error ?? title}
      disabled={auto || action.busy}
      onClick={e => { e.stopPropagation(); toggle(); }}
      onKeyDown={e => e.stopPropagation()}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${lit ? 'text-[var(--primary)]' : 'text-[var(--subtle)] opacity-0 group-hover:opacity-100'} ${auto ? 'cursor-default' : ''}`}
    >
      <Star className="h-3.5 w-3.5" strokeWidth={1.75} fill={lit ? 'currentColor' : 'none'} />
    </button>
  );
}
