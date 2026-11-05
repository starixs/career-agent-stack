/**
 * 求职壳的报错只说一句人话（beta-polish ⑤「报错横幅」）：原样英文报错、SDK / terminal_reason
 * 这类开发者文字不给学生看，细节只进日志（console 由 frontendLogger 收进统一日志）。
 * keystone 通用的 agentError 横幅与 TerminalReasonBanner 保留，Chat 按 CAREER_PLAIN_COPY 二选一。
 */
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { careerErrorCopy } from '../../../shared/careerErrorCopy';
import { describeTerminalReason } from '../../../shared/terminalReason';

/** 本轮停下的原因要不要告诉学生：info 级（正常结束、转后台）与用户自己停下（aborted_*）不说。 */
export function careerTerminalReasonDetail(reason: string | null): string | null {
  const info = describeTerminalReason(reason);
  if (!info || info.severity === 'info') return null;
  return `terminal_reason=${reason} · ${info.label}`;
}

interface CareerErrorLineProps {
  /** 原始报错，只写日志，不渲染。 */
  detail: string;
  /** 有可以重发的上一句话时给「再试一次」。 */
  onRetry?: () => void;
  onDismiss: () => void;
}

export function CareerErrorLine({ detail, onRetry, onDismiss }: CareerErrorLineProps) {
  const { t } = useTranslation('chat');
  useEffect(() => {
    console.warn('[chat] career-error-line shown', detail);
  }, [detail]);
  return (
    <div className="relative z-10 flex-shrink-0 border-b border-[var(--line)] bg-[var(--inset)] px-4 py-2 text-sm text-[var(--ink)]" data-testid="career-error-line">
      <div className="mx-auto flex max-w-[820px] items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--primary)]" aria-hidden="true" />
        <span className="flex-1">{careerErrorCopy(detail) ?? t('shell.career.errorLine')}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium text-[var(--primary)] transition-colors hover:bg-[var(--primary-soft)]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t('shell.career.retry')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-0.5 text-[var(--subtle)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--muted)]"
          title={t('shell.common.close')}
          aria-label={t('shell.common.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
