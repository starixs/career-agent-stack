/**
 * 页面底部输入框 ↔ 对话之间的「从哪一页来」：
 * 页面发出的消息带上 `page:<kind>[:<view>]` 作为隐藏上下文的 surface；
 * 对话里那一轮回复结束后，据此挂一张「回到 XX」卡片，点了回到原页面看结果。
 */
import { WORKBENCHES, findSkillPoint } from '@/components/career/skills/catalog';
import { surfaceToKind } from '@/features/career-shared/nav';
import { CAREER_PAGE_KINDS, type CareerPageKind } from '@/types/tab';

import { NAV_AREAS, type NavTarget } from './navModel';

export type PageTarget = { kind: CareerPageKind; view?: string };

const PREFIX = 'page:';

export function pageSurfaceId(target: PageTarget): string {
  return `${PREFIX}${target.kind}${target.view ? `:${target.view}` : ''}`;
}

export function parsePageSurface(surface: string | null | undefined): PageTarget | null {
  if (!surface?.startsWith(PREFIX)) return null;
  const [kind, view] = surface.slice(PREFIX.length).split(':');
  if (!(CAREER_PAGE_KINDS as readonly string[]).includes(kind)) return null;
  return view ? { kind: kind as CareerPageKind, view } : { kind: kind as CareerPageKind };
}

/**
 * 这一轮该回到哪一页：底部输入框发的是 `page:…`；页面上的按钮（「帮我准备这场面试」「交给助理处理」）
 * 只带面板名（today / inbox / dossier…），同样是从那一页来的，也给回程。对话里卡片的来源（apply 等）不算页面。
 * 不带子视图时回到那一页当前停着的视图（页面切走不卸载，停在哪就回哪）。
 */
export function returnTargetOf(surface: string | null | undefined): PageTarget | null {
  const page = parsePageSurface(surface);
  if (page) return page;
  const kind = surfaceToKind(surface);
  return kind ? { kind } : null;
}

/** 功能市场里的页：技能点详情按技能点叫，工作台按工作台叫。 */
function marketLabel(target: PageTarget): string | null {
  if (target.kind === 'career-guide') return findSkillPoint(target.view)?.name ?? '功能市场';
  const bench = WORKBENCHES.find(item => item.open.kind === target.kind && 'view' in item.open && item.open.view === target.view);
  return bench?.name ?? null;
}

/** 二级导航里这一页叫什么；功能市场里的页按清单叫；都不是就退回通用叫法。 */
export function pageLabel(target: PageTarget): string {
  for (const area of NAV_AREAS) {
    const item = area.items.find(candidate => {
      const t: NavTarget = candidate.target;
      if (t.kind !== target.kind) return false;
      const view = 'view' in t ? t.view : undefined;
      return view === undefined || view === target.view;
    });
    if (item) return item.label;
  }
  return marketLabel(target) ?? '刚才那一页';
}
