/**
 * 求职壳里设置页专属的几块（beta-polish ⑥ 设置与关于）。
 * keystone 的条目仍在 SettingsPage 里（撤出不等于删代码），求职壳只是不渲染它们，换成这里的版本。
 */
import { useTranslation } from 'react-i18next';

import { CareerKeysPanel, useCareerSetupStatus } from '@/components/career/CareerKeysPanel';

/**
 * 模型 Key：内测包预置了 Key（来源 build）或已经配好时整组不出现；
 * 只有真的缺 Key 时才露出来，让他填一次。搜索不再单独要 Key。不画框、不带解释句。
 */
export function CareerModelKeyBlock() {
  const { t } = useTranslation('settings');
  const { status } = useCareerSetupStatus();
  if (!status || status.llm.configured) return null;
  return (
    <div data-testid="settings-career-keys">
      <h3 className="mb-3 text-xs font-medium text-[var(--muted)]">{t('general.careerModelKeyTitle')}</h3>
      <CareerKeysPanel show="llm" />
    </div>
  );
}
