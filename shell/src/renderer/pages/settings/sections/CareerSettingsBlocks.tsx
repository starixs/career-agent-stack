/**
 * 求职壳里设置页专属的几块（beta-polish ⑥ 设置与关于）。
 * keystone 的条目仍在 SettingsPage 里（撤出不等于删代码），求职壳只是不渲染它们，换成这里的版本。
 */
import { useTranslation } from 'react-i18next';

import { CareerKeysPanel, useCareerSetupStatus } from '@/components/career/CareerKeysPanel';

/**
 * 模型 Key：内测包预置了 Key（来源 build）或已经配好时整组不出现；
 * 只有真的缺 Key 时才露出来，让他填一次。搜索不再单独要 Key。
 */
export function CareerModelKeyBlock() {
  const { t } = useTranslation('settings');
  const { status } = useCareerSetupStatus();
  if (!status || status.llm.configured) return null;
  return (
    <div data-testid="settings-career-keys" className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-5">
      <h3 className="text-base font-medium text-[var(--ink)]">{t('general.careerModelKeyTitle')}</h3>
      <p className="mt-1 mb-4 text-xs text-[var(--muted)]">{t('general.careerModelKeyDescription')}</p>
      <CareerKeysPanel show="llm" />
    </div>
  );
}

/** 关于页：反馈入口 + 一句隐私说明。产品名与版本号在页头。 */
export function CareerAboutExtras({ onOpenFeedback }: { onOpenFeedback: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <div data-testid="settings-career-about-feedback" className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-5">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-medium text-[var(--ink)]">{t('about.careerFeedbackTitle')}</h3>
          <button
            type="button"
            onClick={onOpenFeedback}
            className="shrink-0 rounded-lg bg-[var(--inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper)]"
          >
            {t('about.careerFeedbackAction')}
          </button>
        </div>
      </div>
      <p className="text-center text-xs text-[var(--muted)]">{t('about.careerPrivacy')}</p>
    </>
  );
}
