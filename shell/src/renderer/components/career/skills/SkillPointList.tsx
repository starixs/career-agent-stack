/**
 * 技能点：一行一个——名字、它交回来的是什么、做过几次。
 * 有东西要选或有成果可看的，点开就地展开（选一下、点一下开始，下面是做出过的成果）；
 * 自己在做的点了去看结果；其余点了把那句话预填进对话输入框。
 */
import { ArrowUpRight, ChevronRight, MessageSquareText } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { requestNavigation } from '@/features/career-shell/navModel';
import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { suggestToChat } from '../CareerPrimitives';

import { SKILL_POINTS, expands, type SkillPoint } from './catalog';
import { SkillResults } from './SkillResults';
import { StartBar } from './StartBar';

function activate(point: SkillPoint, onToggle: (id: string) => void): void {
  if (expands(point)) { onToggle(point.id); return; }
  if (point.open) { requestNavigation(point.open); return; }
  suggestToChat(point.ask, { surface: 'guide', note: `功能市场 · ${point.name}` }, 'prefill');
}

function PointRow({ point, open, done, onToggle }: { point: SkillPoint; open: boolean; done: number; onToggle: (id: string) => void }) {
  const expandable = expands(point);
  const row = useRef<HTMLLIElement>(null);
  // 从对话里的回程卡回来时，这一行可能在屏幕外：展开的同时把它带到眼前
  useEffect(() => { if (open) row.current?.scrollIntoView?.({ block: 'nearest' }); }, [open]);
  // 行尾的小图标说明点了会怎样：展开 / 去一个页面 / 去对话
  const Trailing = expandable ? ChevronRight : point.open ? ArrowUpRight : MessageSquareText;
  return (
    <li ref={row}>
      <button
        type="button" aria-expanded={expandable ? open : undefined} onClick={() => activate(point, onToggle)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <span className="w-36 shrink-0 text-sm font-semibold text-[var(--ink)]">{point.name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--muted)]">{point.gives}</span>
        {done > 0 && <span className="shrink-0 text-xs tabular-nums text-[var(--subtle)]">{done}</span>}
        <Trailing className={`h-4 w-4 shrink-0 text-[var(--subtle)] transition-transform ${expandable && open ? 'rotate-90' : ''}`} strokeWidth={1.75} aria-hidden />
      </button>
      {expandable && open && (
        <div className="space-y-4 pb-5 pt-1">
          {/* 这一轮回复结束后，对话里会有一张卡带他回到这一行看成果 */}
          {point.start && <StartBar spec={point.start} surface={pageSurfaceId({ kind: 'career-guide', view: point.id })} />}
          {point.results && <SkillResults kind={point.results} />}
        </div>
      )}
    </li>
  );
}

export function SkillPointList({ openId, done, onToggle }: { openId: string | null; done: Record<string, number>; onToggle: (id: string) => void }) {
  return (
    <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
      {SKILL_POINTS.map(point => <PointRow key={point.id} point={point} open={openId === point.id} done={done[point.id] ?? 0} onToggle={onToggle} />)}
    </ul>
  );
}
