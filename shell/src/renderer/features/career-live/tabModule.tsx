import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerLiveTab } from '@/features/career-live/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

const CareerLive = lazy(async () => {
  const page = await import('@/pages/CareerLive');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerLiveOpenIntent { title: string }
export type CareerLiveRenderBinding = CareerPageRenderBinding;

const CareerLiveTabRenderer = memo(function CareerLiveTabRenderer({ isActive, isDeferred, binding }: { tab: CareerLiveTab; isActive: boolean; isDeferred: boolean; binding: CareerLiveRenderBinding }) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerLive isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerLiveTabModule = {
  kind: 'career-live',
  render: CareerLiveTabRenderer,
  chrome: (_tab, { t }) => ({ title: t('tabs.careerLive'), subtitle: t('tabs.careerLive') }),
  identity: () => 'career-live',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({ id, view: 'career-live', title: intent.title }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerLiveTab, CareerLiveOpenIntent, CareerLiveRenderBinding>;
