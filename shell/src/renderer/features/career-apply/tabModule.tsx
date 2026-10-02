import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerApplyTab } from '@/features/career-apply/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerApply = lazy(async () => {
  const page = await import('@/pages/CareerApply');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerApplyOpenIntent {
  title: string;
}

export type CareerApplyRenderBinding = CareerPageRenderBinding;

const CareerApplyTabRenderer = memo(function CareerApplyTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerApplyTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerApplyRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerApply isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerApplyTabModule = {
  kind: 'career-apply',
  render: CareerApplyTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerApply'),
    subtitle: t('tabs.careerApply'),
  }),
  identity: () => 'career-apply',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-apply',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerApplyTab, CareerApplyOpenIntent, CareerApplyRenderBinding>;
