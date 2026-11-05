/**
 * Feedback entry: "AI 小助理" (opens BugReportOverlay) and "加入用户群" (shows QR code).
 * Rendered in Settings › 帮助与反馈. 无框、裸图标；二维码拿不到或加载失败时整块不出现。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, Loader2, Users } from 'lucide-react';

import { apiGetJson } from '@/api/apiFetch';
import { isTauriEnvironment } from '@/utils/browserMock';

const QR_CDN_URL = 'https://download.keystone.io/assets/feedback_qr_code.png';

interface FeedbackPanelProps {
    onOpenBugReport: () => void;
    /** Called right before the bug report opens (e.g. to close a popover). */
    onBeforeOpenBugReport?: () => void;
}

export function FeedbackPanel({ onOpenBugReport, onBeforeOpenBugReport }: FeedbackPanelProps) {
    const { t } = useTranslation('app');
    const isTauri = isTauriEnvironment();
    const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(isTauri ? null : QR_CDN_URL);
    const [qrLoading, setQrLoading] = useState(isTauri);
    const [qrFailed, setQrFailed] = useState(false);

    // Load QR code from Sidecar in Tauri mode
    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;

        apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
            .then(result => {
                if (cancelled) return;
                if (result.success && result.dataUrl) {
                    setQrCodeUrl(result.dataUrl);
                }
            })
            .catch((e: unknown) => { console.warn('[feedback] qr-code load FAILED', e); })
            .finally(() => { if (!cancelled) setQrLoading(false); });

        return () => { cancelled = true; };
    }, [isTauri]);

    const showQr = !qrFailed && (qrLoading || qrCodeUrl !== null);

    return (
        <div className="divide-y divide-[var(--line)]">
            {/* AI 小助理 */}
            <button
                type="button"
                onClick={() => {
                    onBeforeOpenBugReport?.();
                    onOpenBugReport();
                }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-[var(--hover)]"
            >
                <Bot className="h-5 w-5 shrink-0 text-[var(--muted)]" strokeWidth={1.75} aria-hidden="true" />
                <span className="flex-1 text-sm font-medium text-[var(--ink)]">{t('titlebar.helper')}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
            </button>

            {/* 加入用户群：二维码拿不到或加载失败时整块不出现 */}
            {showQr && (
                <div className="px-3 py-3">
                    <div className="flex items-center gap-3">
                        <Users className="h-5 w-5 shrink-0 text-[var(--muted)]" strokeWidth={1.75} aria-hidden="true" />
                        <span className="text-sm font-medium text-[var(--ink)]">{t('titlebar.communityTitle')}</span>
                    </div>
                    <div className="mt-3 pl-8">
                        {qrLoading || !qrCodeUrl ? (
                            <div className="flex h-32 w-32 items-center justify-center">
                                <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
                            </div>
                        ) : (
                            <img
                                src={qrCodeUrl}
                                alt={t('titlebar.communityQrAlt')}
                                onError={() => setQrFailed(true)}
                                className="h-32 w-32 rounded-md"
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
