import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerInboxTab } from '@/features/career-inbox/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerInbox = lazy(async () => {
  const page = await import('@/pages/CareerInbox');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerInboxOpenIntent {
  title: string;
}

export type CareerInboxRenderBinding = CareerPageRenderBinding;

const CareerInboxTabRenderer = memo(function CareerInboxTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerInboxTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerInboxRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerInbox isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerInboxTabModule = {
  kind: 'career-inbox',
  render: CareerInboxTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerInbox'),
    subtitle: t('tabs.careerInbox'),
  }),
  identity: () => 'career-inbox',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-inbox',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerInboxTab, CareerInboxOpenIntent, CareerInboxRenderBinding>;
