/**
 * 邮箱连接中心（P0）：每家邮箱一张卡，带连接状态。点卡片按状态进不同的页：
 * 没连 → 说明页；失效 → 直接进拿授权码的引导（跳过说明）；已连接 → 连接管理。
 * 通知中心、助力记录、基本资料、对话里的绑定卡片共用这一个入口。
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { careerApi } from '../careerApi';
import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import type { MailAccount, MailConnector } from '../types';
import { useCareerQuery } from '../useCareerData';
import { ConnectorIcon, StatusBadge, connectorStatus } from './connectorUi';
import { MailConnectFlow, type FlowStart } from './MailConnectFlow';

const TABLES = ['mail_account'] as const;

export interface MailConnectCenterProps {
  /** 从对话里来：连好后回调，由调用方回到对话播报。 */
  from?: 'chat';
  onConnected?: (account: MailAccount) => void;
}

export function MailConnectCenter({ from, onConnected }: MailConnectCenterProps) {
  const q = useCareerQuery(careerApi.mailConnectors, TABLES);
  const [open, setOpen] = useState<FlowStart | null>(null);
  const connectors = q.data?.connectors ?? [];
  const accounts = q.data?.accounts ?? [];
  const apply = q.data?.applyAddress ?? null;
  const accountsOf = (c: MailConnector) => accounts.filter(a => a.provider === c.id);

  const openCard = (c: MailConnector) => {
    const mine = accountsOf(c);
    const status = connectorStatus(mine);
    if (status === 'none') setOpen({ connector: c, step: 'intro', prefill: apply?.connector_id === c.id ? apply.address : undefined });
    else if (status === 'expired') {
      const expired = mine.find(a => a.connection?.state === 'expired')!;
      setOpen({ connector: c, step: 'guide', reauthorize: expired });
    } else setOpen({ connector: c, step: 'manage', account: mine[0] });
  };

  return (
    <div>
      {q.loading && !q.data && <LoadingRow />}
      {q.error && <ErrorRow message={q.error} onRetry={q.reload} />}
      {q.data && !accounts.length && (
        <p className="mb-3 text-sm text-[var(--muted)]">还没有连接邮箱。连上后，近半年的网申、笔试、面试邮件会自动收进来，以后的新邮件也会自动识别。</p>
      )}
      <ul aria-label="邮箱连接" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {connectors.map(c => {
          const mine = accountsOf(c);
          const status = connectorStatus(mine);
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => openCard(c)}
                className="group flex w-full items-center gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] px-3 py-3 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <ConnectorIcon id={c.id} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--ink)]">{c.name}</span>
                    <StatusBadge status={status} />
                  </span>
                  <span className="block truncate text-xs text-[var(--muted)]">
                    {mine.length ? mine.map(a => a.address).join('、') : apply?.connector_id === c.id ? `网申填的是 ${apply.address}` : '用授权码连接，大约 1 分钟'}
                  </span>
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--subtle)] group-hover:text-[var(--ink)]" />
              </button>
            </li>
          );
        })}
      </ul>
      {open && (
        <MailConnectFlow
          start={open}
          from={from}
          onClose={() => { setOpen(null); q.reload(); }}
          onConnected={account => { q.reload(); onConnected?.(account); }}
        />
      )}
    </div>
  );
}
