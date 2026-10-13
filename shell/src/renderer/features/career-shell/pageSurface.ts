/**
 * 页面底部输入框 ↔ 对话之间的「从哪一页来」：
 * 页面发出的消息带上 `page:<kind>[:<view>]` 作为隐藏上下文的 surface；
 * 对话里那一轮回复结束后，据此挂一张「回到 XX」卡片，点了回到原页面看结果。
 */
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

/** 二级导航里这一页叫什么；没在导航里的页面退回通用叫法。 */
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
  return '刚才那一页';
}
