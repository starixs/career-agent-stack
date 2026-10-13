/**
 * Settings › 小助理与反馈.
 *
 * This used to live in the keystone global sidebar (helper entry). It is parked
 * in Settings until the product decides whether to keep it.
 */
import { useTranslation } from 'react-i18next';

import { FeedbackPanel } from '@/components/FeedbackPanel';
import { requestBugReport } from '@/features/career-shell/shellEvents';

export function FeedbackSection() {
  const { t } = useTranslation('app');
  return (
    <div className="mx-auto max-w-xl px-8 py-8">
      <h2 className="mb-4 text-lg font-semibold text-[var(--ink)]">{t('titlebar.feedbackTitle')}</h2>
      <div className="-mx-3">
        <FeedbackPanel onOpenBugReport={requestBugReport} />
      </div>
    </div>
  );
}
