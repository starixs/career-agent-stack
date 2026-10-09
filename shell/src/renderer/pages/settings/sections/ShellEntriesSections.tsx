/**
 * Settings › 通知 and Settings › 小助理与反馈.
 *
 * These used to live in the keystone global sidebar (bell + helper entry). They
 * are parked in Settings until the product decides whether to keep them.
 */
import { useTranslation } from 'react-i18next';

import { FeedbackPanel } from '@/components/FeedbackPopover';
import { requestAppRoute, requestBugReport } from '@/features/career-shell/shellEvents';
import NotificationCenterFlyout from '@/notifications/NotificationCenterFlyout';
import { useNotificationCenter } from '@/notifications/useNotificationCenter';

export function NotificationsSection() {
  const { t } = useTranslation('app');
  const center = useNotificationCenter();
  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h2 className="mb-4 text-lg font-semibold text-[var(--ink)]">{t('notificationCenter.title')}</h2>
      <div className="h-[min(640px,calc(100vh-180px))] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)]">
        <NotificationCenterFlyout
          snapshot={center.snapshot}
          onRefresh={center.refresh}
          onLoadMore={center.loadMore}
          onMarkAllRead={center.markAllRead}
          onOpenAppRoute={route => {
            requestAppRoute(route);
            return true;
          }}
          onClose={() => {}}
        />
      </div>
    </div>
  );
}

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
