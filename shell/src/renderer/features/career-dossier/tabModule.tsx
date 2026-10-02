import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerDossierTab } from '@/features/career-dossier/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

// 页面按 CareerPageProps 松耦合接收 props（可声明也可不声明），见 pageContract.ts。
const CareerDossier = lazy(async () => {
  const page = await import('@/pages/CareerDossier');
  return { default: page.default as ComponentType<CareerPageProps> };
});

export interface CareerDossierOpenIntent {
  title: string;
}

export type CareerDossierRenderBinding = CareerPageRenderBinding;

const CareerDossierTabRenderer = memo(function CareerDossierTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerDossierTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerDossierRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerDossier isActive={isActive} onOpenChat={binding.onOpenChat} />
    </Suspense>
  );
});

export const careerDossierTabModule = {
  kind: 'career-dossier',
  render: CareerDossierTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerDossier'),
    subtitle: t('tabs.careerDossier'),
  }),
  identity: () => 'career-dossier',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-dossier',
      title: intent.title,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerDossierTab, CareerDossierOpenIntent, CareerDossierRenderBinding>;
