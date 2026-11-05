/**
 * 功能市场的两种卡片：一幅插画 + 名字，整张可点。
 *  - 工作台卡：上面一幅大插画，下面只有名字；
 *  - 技能点卡：左边小插画，右边名字和它交回来的是什么。
 * 没有「添加 / 安装」，不写说明句，也不放「做过几次」这类计数（新用户看不懂，老用户用不上）——是什么靠插画和名字认。
 */
import type { SkillPoint, Workbench } from './catalog';
import { SkillArt } from './SkillArt';

const CARD = 'group w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] text-left transition-[border-color,box-shadow] duration-150 hover:border-[var(--line-2)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';

export function WorkbenchCard({ item, onOpen }: { item: Workbench; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={`${CARD} flex h-full flex-col overflow-hidden`}>
      <span className="flex h-28 items-center justify-center border-b border-[var(--line)] bg-[var(--inset)]">
        <SkillArt id={item.id} className="h-[84px] w-[126px]" />
      </span>
      <span className="px-4 py-3 font-human text-base font-semibold text-[var(--ink)]">{item.name}</span>
    </button>
  );
}

export function SkillPointCard({ item, onOpen }: { item: SkillPoint; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={`${CARD} flex items-center gap-4 p-3`}>
      <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-[var(--inset)]">
        <SkillArt id={item.id} className="h-12 w-[72px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-human text-base font-semibold text-[var(--ink)]">{item.name}</span>
        <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{item.gives}</span>
      </span>
    </button>
  );
}
