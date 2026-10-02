import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerResearchTab } from '@/features/career-research/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerResearch = lazy(async () => {
  const page = await import('@/pages/CareerResearch');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerResearchOpenIntent {
  title: string;
}

export type CareerResearchRenderBinding = CareerPageRenderBinding;

const CareerResearchTabRenderer = memo(function CareerResearchTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerResearchTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerResearchRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerResearch isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerResearchTabModule = {
  kind: 'career-research',
  render: CareerResearchTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerResearch'),
    subtitle: t('tabs.careerResearch'),
  }),
  identity: () => 'career-research',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-research',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerResearchTab, CareerResearchOpenIntent, CareerResearchRenderBinding>;
