/**
 * 五个面 + 指南的唯一清单：侧栏、Tab 标题、focus 事件都从这里取，不再各处手写 kind。
 * 顺序即侧栏顺序（围绕一天的流程：先看今日，再处理收件箱，再翻卷宗 / 素材，最后复盘）。
 */
export const CAREER_SURFACES = [
  { kind: 'career-today', surface: 'today', titleKey: 'tabs.careerToday', navKey: 'globalSidebar.careerToday', icon: 'sun' },
  { kind: 'career-inbox', surface: 'inbox', titleKey: 'tabs.careerInbox', navKey: 'globalSidebar.careerInbox', icon: 'inbox' },
  { kind: 'career-dossier', surface: 'dossier', titleKey: 'tabs.careerDossier', navKey: 'globalSidebar.careerDossier', icon: 'folder' },
  { kind: 'career-material', surface: 'material', titleKey: 'tabs.careerMaterial', navKey: 'globalSidebar.careerMaterial', icon: 'library' },
  { kind: 'career-review', surface: 'review', titleKey: 'tabs.careerReview', navKey: 'globalSidebar.careerReview', icon: 'chart' },
  { kind: 'career-guide', surface: 'guide', titleKey: 'tabs.careerGuide', navKey: 'globalSidebar.careerGuide', icon: 'compass' },
  // 两个辅助面：浏览器现场（看助理操作 / 接管 / 批量投递）与私密信息（不进模型上下文的个人资料与账号）
  { kind: 'career-live', surface: 'live', titleKey: 'tabs.careerLive', navKey: 'globalSidebar.careerLive', icon: 'eye' },
  { kind: 'career-vault', surface: 'vault', titleKey: 'tabs.careerVault', navKey: 'globalSidebar.careerVault', icon: 'lock' },
] as const;

export type CareerSurfaceKind = typeof CAREER_SURFACES[number]['kind'];
export type CareerSurfaceName = typeof CAREER_SURFACES[number]['surface'];

export const CAREER_SURFACE_KINDS: readonly CareerSurfaceKind[] = CAREER_SURFACES.map(s => s.kind);
export const CAREER_PAGE_TITLE_KEYS: Record<CareerSurfaceKind, string> = Object.fromEntries(CAREER_SURFACES.map(s => [s.kind, s.titleKey])) as Record<CareerSurfaceKind, string>;

export function surfaceToKind(surface: string | null | undefined): CareerSurfaceKind | null {
  return CAREER_SURFACES.find(s => s.surface === surface)?.kind ?? null;
}
