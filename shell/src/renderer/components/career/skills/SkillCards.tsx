/**
 * 功能市场的两种卡片，照基座展示技能的方式（一张卡 = 名字 + 一句话，点开看详情）：
 *  - 工作台卡：上面是产出小样，下面是名字、一句话和真实计数；
 *  - 技能点卡：左边小样，右边名字和一句话。
 * 整张卡可点，没有「添加 / 安装」——点了就用。
 */
import type { SkillPoint, Workbench } from './catalog';
import { Specimen } from './Specimen';

const CARD = 'group w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] text-left transition-[border-color,box-shadow] duration-150 hover:border-[var(--line-2)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';

export function WorkbenchCard({ item, count, onOpen }: { item: Workbench; count?: string; onOpen: () => void }) {
  const Icon = item.icon;
  return (
    <button type="button" onClick={onOpen} className={`${CARD} flex h-full flex-col overflow-hidden`}>
      <span className="flex h-24 items-center justify-center border-b border-[var(--line)] bg-[var(--inset)]">
        <Specimen kind={item.specimen} className="h-[68px] w-[109px]" />
      </span>
      <span className="flex flex-1 flex-col gap-1 px-4 py-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ink)]">
          <Icon className="h-4 w-4 shrink-0 text-[var(--muted)]" strokeWidth={1.75} aria-hidden />
          {item.name}
        </span>
        <span className="text-pretty text-xs leading-relaxed text-[var(--muted)]">{item.promise}</span>
        {count && <span className="mt-auto pt-1 text-xs tabular-nums text-[var(--subtle)]">{count}</span>}
      </span>
    </button>
  );
}

export function SkillPointCard({ item, count, onOpen }: { item: SkillPoint; count?: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={`${CARD} flex items-center gap-3.5 px-3.5 py-3`}>
      <span className="flex h-14 w-[88px] shrink-0 items-center justify-center rounded-md bg-[var(--inset)]">
        <Specimen kind={item.specimen} className="h-[45px] w-[72px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-[var(--ink)]">{item.name}</span>
          {item.auto && <span className="text-xs text-[var(--subtle)]">自动在做</span>}
          {count && <span className="ml-auto shrink-0 text-xs tabular-nums text-[var(--subtle)]">{count}</span>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-pretty text-xs leading-relaxed text-[var(--muted)]">{item.promise}</span>
      </span>
    </button>
  );
}
