import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerTodayTab } from '@/features/career-today/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerToday = lazy(async () => {
  const page = await import('@/pages/CareerToday');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerTodayOpenIntent {
  title: string;
}

export type CareerTodayRenderBinding = CareerPageRenderBinding;

const CareerTodayTabRenderer = memo(function CareerTodayTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerTodayTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerTodayRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerToday isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerTodayTabModule = {
  kind: 'career-today',
  render: CareerTodayTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerToday'),
    subtitle: t('tabs.careerToday'),
  }),
  identity: () => 'career-today',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-today',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerTodayTab, CareerTodayOpenIntent, CareerTodayRenderBinding>;
