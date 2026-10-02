import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerExperienceTab } from '@/features/career-experience/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerExperience = lazy(async () => {
  const page = await import('@/pages/CareerExperience');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerExperienceOpenIntent {
  title: string;
}

export type CareerExperienceRenderBinding = CareerPageRenderBinding;

const CareerExperienceTabRenderer = memo(function CareerExperienceTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerExperienceTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerExperienceRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerExperience isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerExperienceTabModule = {
  kind: 'career-experience',
  render: CareerExperienceTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerExperience'),
    subtitle: t('tabs.careerExperience'),
  }),
  identity: () => 'career-experience',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-experience',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerExperienceTab, CareerExperienceOpenIntent, CareerExperienceRenderBinding>;
