import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerReviewTab } from '@/features/career-review/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerReview = lazy(async () => {
  const page = await import('@/pages/CareerReview');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerReviewOpenIntent {
  title: string;
}

export type CareerReviewRenderBinding = CareerPageRenderBinding;

const CareerReviewTabRenderer = memo(function CareerReviewTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerReviewTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerReviewRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerReview isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerReviewTabModule = {
  kind: 'career-review',
  render: CareerReviewTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerReview'),
    subtitle: t('tabs.careerReview'),
  }),
  identity: () => 'career-review',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-review',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerReviewTab, CareerReviewOpenIntent, CareerReviewRenderBinding>;
