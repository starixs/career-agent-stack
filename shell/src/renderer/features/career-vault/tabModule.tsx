import { lazy, memo, Suspense, type ComponentType } from 'react';

import type { CareerVaultTab } from '@/features/career-vault/tabContract';
import type { CareerPageProps, CareerPageRenderBinding } from '@/features/career-shared/pageContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';

type VaultPageProps = CareerPageProps & { focusExperienceId?: string };

const CareerVault = lazy(async () => {
  const page = await import('@/pages/CareerVault');
  return { default: page.default as ComponentType<VaultPageProps> };
});

export interface CareerVaultOpenIntent {
  title: string;
  focusExperienceId?: string;
}

export type CareerVaultRenderBinding = CareerPageRenderBinding;

const CareerVaultTabRenderer = memo(function CareerVaultTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: CareerVaultTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CareerVaultRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <CareerVault isActive={isActive} onOpenChat={binding.onOpenChat} focusExperienceId={tab.focusExperienceId} />
    </Suspense>
  );
});

export const careerVaultTabModule = {
  kind: 'career-vault',
  render: CareerVaultTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.careerVault'),
    subtitle: t('tabs.careerVault'),
  }),
  identity: () => 'career-vault',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'career-vault',
      title: intent.title,
      ...(intent.focusExperienceId ? { focusExperienceId: intent.focusExperienceId } : {}),
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CareerVaultTab, CareerVaultOpenIntent, CareerVaultRenderBinding>;
