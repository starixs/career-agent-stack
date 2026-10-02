import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerInterviewTab } from '@/features/career-interview/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerInterview = lazy(async () => {
  const page = await import('@/pages/CareerInterview');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerInterviewOpenIntent {
  title: string;
}

export type CareerInterviewRenderBinding = CareerPageRenderBinding;

const CareerInterviewTabRenderer = memo(function CareerInterviewTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerInterviewTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerInterviewRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerInterview isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerInterviewTabModule = {
  kind: 'career-interview',
  render: CareerInterviewTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerInterview'),
    subtitle: t('tabs.careerInterview'),
  }),
  identity: () => 'career-interview',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-interview',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerInterviewTab, CareerInterviewOpenIntent, CareerInterviewRenderBinding>;
