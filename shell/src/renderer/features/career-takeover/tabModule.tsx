import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerTakeoverTab } from '@/features/career-takeover/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerTakeover = lazy(async () => {
  const page = await import('@/pages/CareerTakeover');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerTakeoverOpenIntent {
  title: string;
}

export type CareerTakeoverRenderBinding = CareerPageRenderBinding;

const CareerTakeoverTabRenderer = memo(function CareerTakeoverTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerTakeoverTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerTakeoverRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerTakeover isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerTakeoverTabModule = {
  kind: 'career-takeover',
  render: CareerTakeoverTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerTakeover'),
    subtitle: t('tabs.careerTakeover'),
  }),
  identity: () => 'career-takeover',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-takeover',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerTakeoverTab, CareerTakeoverOpenIntent, CareerTakeoverRenderBinding>;
