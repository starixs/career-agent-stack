import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerResumeTab } from '@/features/career-resume/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerResume = lazy(async () => {
  const page = await import('@/pages/CareerResume');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerResumeOpenIntent {
  title: string;
}

export type CareerResumeRenderBinding = CareerPageRenderBinding;

const CareerResumeTabRenderer = memo(function CareerResumeTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerResumeTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerResumeRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerResume isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerResumeTabModule = {
  kind: 'career-resume',
  render: CareerResumeTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerResume'),
    subtitle: t('tabs.careerResume'),
  }),
  identity: () => 'career-resume',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-resume',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerResumeTab, CareerResumeOpenIntent, CareerResumeRenderBinding>;
