/**
 * Two-level navigation model for the career product (specs/CAREER_DESIGN.md §5).
 *
 * L1 picks an area; L2 picks a work page inside it. Each L2 item resolves to an
 * existing tab view plus, for pages that hold several views, the sub-view to show.
 * The L2 list never repeats the area name.
 */
import { emitEvent } from '@/api/eventBus';
import type { CareerPageKind } from '@/types/tab';

export type NavArea = 'work' | 'chat' | 'career' | 'market' | 'assets' | 'settings';

export type NavTarget =
  | { kind: 'chat' }
  | { kind: 'settings'; section?: string }
  | { kind: 'capabilities' }
  | { kind: 'taskcenter' }
  | { kind: CareerPageKind; view?: string };

export interface NavItem {
  id: string;
  label: string;
  icon: NavIconName;
  target: NavTarget;
}

export type NavIconName =
  | 'dashboard' | 'chat' | 'briefcase' | 'grid' | 'folder' | 'settings'
  | 'sun' | 'list' | 'inbox' | 'star' | 'send' | 'pencil' | 'users' | 'user' | 'file' | 'quote' | 'award'
  | 'sliders' | 'pet' | 'globe' | 'keyboard' | 'wrench' | 'bell' | 'help' | 'info';

export interface NavAreaDefinition {
  id: NavArea;
  label: string;
  icon: NavIconName;
  /** Areas without sub-pages (chat, market) render no L2 column. */
  items: readonly NavItem[];
  /** Rendered in the rail's bottom group instead of the main group. */
  footer?: boolean;
}

export const NAV_AREAS: readonly NavAreaDefinition[] = [
  {
    id: 'work', label: '工作台', icon: 'dashboard', items: [
      { id: 'today', label: '今日概览', icon: 'sun', target: { kind: 'career-today' } },
      { id: 'tasks', label: '任务中心', icon: 'list', target: { kind: 'taskcenter' } },
      { id: 'inbox', label: '通知收件箱', icon: 'inbox', target: { kind: 'career-inbox' } },
    ],
  },
  { id: 'chat', label: '对话', icon: 'chat', items: [] },
  {
    id: 'career', label: '我的求职', icon: 'briefcase', items: [
      { id: 'saved', label: '岗位收藏', icon: 'star', target: { kind: 'career-dossier', view: 'apply' } },
      { id: 'applications', label: '投递记录', icon: 'send', target: { kind: 'career-dossier', view: 'line' } },
      { id: 'exams', label: '笔试记录', icon: 'pencil', target: { kind: 'career-dossier', view: 'exam' } },
      { id: 'interviews', label: '面试记录', icon: 'users', target: { kind: 'career-dossier', view: 'interview' } },
      { id: 'offers', label: 'Offer 记录', icon: 'award', target: { kind: 'career-dossier', view: 'offer' } },
    ],
  },
  { id: 'market', label: '功能市场', icon: 'grid', items: [] },
  {
    id: 'assets', label: '我的资料', icon: 'folder', items: [
      { id: 'profile', label: '基本资料', icon: 'user', target: { kind: 'career-vault' } },
      { id: 'experience', label: '经历', icon: 'star', target: { kind: 'career-material', view: 'experience' } },
      { id: 'resumes', label: '简历', icon: 'file', target: { kind: 'career-material', view: 'resume' } },
      { id: 'phrases', label: '常用表达', icon: 'quote', target: { kind: 'career-material', view: 'library' } },
    ],
  },
  {
    // 技能与工具、通知、小助理暂时停放在设置里，去留待定（2026-10-09）。
    id: 'settings', label: '设置', icon: 'settings', footer: true, items: [
      { id: 'general', label: '通用设置', icon: 'sliders', target: { kind: 'settings', section: 'general' } },
      { id: 'desktop-pet', label: '桌面宠物', icon: 'pet', target: { kind: 'settings', section: 'desktop-pet' } },
      { id: 'proxy', label: '网络代理', icon: 'globe', target: { kind: 'settings', section: 'proxy' } },
      { id: 'shortcuts', label: '快捷键', icon: 'keyboard', target: { kind: 'settings', section: 'shortcuts' } },
      { id: 'capabilities', label: '技能与工具', icon: 'wrench', target: { kind: 'capabilities' } },
      { id: 'notifications', label: '通知', icon: 'bell', target: { kind: 'settings', section: 'notifications' } },
      { id: 'feedback', label: '小助理与反馈', icon: 'help', target: { kind: 'settings', section: 'feedback' } },
      { id: 'about', label: '关于', icon: 'info', target: { kind: 'settings', section: 'about' } },
    ],
  },
];

/** View a multi-view page shows before any L2 choice; pages use the same fallback. */
export const DEFAULT_SUB_VIEWS = {
  'career-dossier': 'line',
  'career-material': 'library',
  'career-review': 'funnel',
} as const;

/** Target opened when an area without L2 items is chosen. */
export const AREA_DIRECT_TARGET: Partial<Record<NavArea, NavTarget>> = {
  chat: { kind: 'chat' },
  market: { kind: 'career-guide' },
};

export function areaDefinition(area: NavArea): NavAreaDefinition {
  return NAV_AREAS.find(definition => definition.id === area)!;
}

/**
 * Locate the area and L2 item for the active tab. `subViews` holds the view each
 * multi-view page currently shows, so 岗位收藏 and 投递记录 can share one tab.
 */
export function locateNav(
  activeView: string | undefined,
  subViews: Readonly<Record<string, string | undefined>>,
): { area: NavArea | null; itemId: string | null } {
  if (!activeView) return { area: null, itemId: null };
  if (activeView === 'chat' || activeView === 'launcher') return { area: 'chat', itemId: null };
  if (activeView === 'capabilities') return { area: 'settings', itemId: 'capabilities' };
  if (activeView === 'settings') return { area: 'settings', itemId: subViews.settings ?? 'general' };
  // 功能市场没有二级栏；从它打开的复盘页也归在这里。
  if (activeView === 'career-guide' || activeView === 'career-review') return { area: 'market', itemId: null };
  for (const area of NAV_AREAS) {
    const match = area.items.find(item => {
      if (item.target.kind !== activeView) return false;
      const view = 'view' in item.target ? item.target.view : undefined;
      const current = subViews[activeView] ?? DEFAULT_SUB_VIEWS[activeView as keyof typeof DEFAULT_SUB_VIEWS];
      return view === undefined || view === current;
    });
    if (match) return { area: area.id, itemId: match.id };
  }
  if (activeView === 'record') return { area: 'work', itemId: 'tasks' };
  return { area: null, itemId: null };
}

/** Event pages emit to navigate elsewhere; App.tsx owns tabs and turns it into a real open. */
export const CAREER_NAVIGATE_EVENT = 'career:navigate';

export function requestNavigation(target: NavTarget): void {
  emitEvent(CAREER_NAVIGATE_EVENT, target);
}
