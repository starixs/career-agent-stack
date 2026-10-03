import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerGuideTab } from '@/features/career-guide/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerGuide = lazy(async () => {
  const page = await import('@/pages/CareerGuide');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerGuideOpenIntent {
  title: string;
}

export type CareerGuideRenderBinding = CareerPageRenderBinding;

const CareerGuideTabRenderer = memo(function CareerGuideTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerGuideTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerGuideRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerGuide isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerGuideTabModule = {
  kind: 'career-guide',
  render: CareerGuideTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerGuide'),
    subtitle: t('tabs.careerGuide'),
  }),
  identity: () => 'career-guide',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-guide',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerGuideTab, CareerGuideOpenIntent, CareerGuideRenderBinding>;
