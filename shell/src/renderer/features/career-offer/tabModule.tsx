import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerOfferTab } from '@/features/career-offer/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerOffer = lazy(async () => {
  const page = await import('@/pages/CareerOffer');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerOfferOpenIntent {
  title: string;
}

export type CareerOfferRenderBinding = CareerPageRenderBinding;

const CareerOfferTabRenderer = memo(function CareerOfferTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerOfferTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerOfferRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerOffer isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerOfferTabModule = {
  kind: 'career-offer',
  render: CareerOfferTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerOffer'),
    subtitle: t('tabs.careerOffer'),
  }),
  identity: () => 'career-offer',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-offer',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerOfferTab, CareerOfferOpenIntent, CareerOfferRenderBinding>;
