import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerMaterialTab } from '@/features/career-material/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerMaterial = lazy(async () => {
  const page = await import('@/pages/CareerMaterial');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerMaterialOpenIntent {
  title: string;
}

export type CareerMaterialRenderBinding = CareerPageRenderBinding;

const CareerMaterialTabRenderer = memo(function CareerMaterialTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerMaterialTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerMaterialRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerMaterial isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerMaterialTabModule = {
  kind: 'career-material',
  render: CareerMaterialTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerMaterial'),
    subtitle: t('tabs.careerMaterial'),
  }),
  identity: () => 'career-material',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-material',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerMaterialTab, CareerMaterialOpenIntent, CareerMaterialRenderBinding>;
