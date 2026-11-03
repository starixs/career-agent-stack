/**
 * 连接管理（P6）：连接状态与健康、近 7 天用量、重新授权、解绑（输入邮箱地址确认），以及助理代操作的留痕。
 * 健康与用量都来自服务端（mail/connect-service.ts mailAccountDetail），界面只展示。
 */
import { useState } from 'react';

import { emitEvent } from '@/api/eventBus';

import { careerApi } from '../careerApi';
import { Button, ErrorRow, LoadingRow, formatDate, relativeTime } from '../CareerPrimitives';
import type { CareerFocusEvent, MailAccount, MailAuditEntry, MailConnector } from '../types';
import { useCareerAction, useCareerQuery } from '../useCareerData';
import { ConnectorIcon, HealthBadge, StatusBadge, connectorStatus } from './connectorUi';

const TABLES = ['mail_account', 'mail_message'] as const;

const ACTOR: Record<MailAuditEntry['actor'], string> = { agent: '助理', user: '你', system: '系统' };
const OPERATION: Record<string, string> = { connect: '连接', reauthorize: '重新授权', import: '收进历史邮件', sync: '收新邮件', send: '代发邮件' };

export function ConnectionManage({ connector, accountId, onReauthorize, onUnbound }: {
  connector: MailConnector;
  accountId: string;
  onReauthorize: (account: MailAccount) => void;
  onUnbound: () => void;
}) {
  const q = useCareerQuery(() => careerApi.mailAccountDetail(accountId), TABLES);
  const act = useCareerAction();
  const [syncNote, setSyncNote] = useState<string | null>(null);
  if (q.loading && !q.data) return <LoadingRow />;
  if (q.error || !q.data) return <ErrorRow message={q.error ?? '没读到这个连接'} onRetry={q.reload} />;
  const { account, usage, audit } = q.data;
  const status = connectorStatus([account]);
  const expired = status === 'expired';
  const sync = () => act.run(async () => {
    const [r] = await careerApi.syncMail(account.id);
    setSyncNote(r?.error ? `没同步成：${r.error}` : `拉到 ${r?.fetched ?? 0} 封，${r?.job_related ?? 0} 封和求职有关`);
  });

  return (
    <div className="grid gap-5">
      <section className="flex items-start gap-3">
        <ConnectorIcon id={connector.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--ink)]">{account.address}</span>
            <StatusBadge status={status} />
            {!expired && <HealthBadge account={account} />}
          </div>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-[var(--muted)]">
            <dt>授权时间</dt><dd>{formatDate(account.created_at)}</dd>
            <dt>最近同步</dt><dd>{relativeTime(account.last_sync_at)}</dd>
          </dl>
          {account.last_error && <p className="mt-1 text-xs text-[var(--danger)]">{account.last_error}</p>}
        </div>
      </section>

      {expired && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-[var(--note)] px-4 py-3 text-sm text-[var(--ink)]">
          <span className="flex-1">授权码失效了，新邮件暂时收不进来。重新拿一个授权码就能恢复。</span>
          <Button variant="primary" onClick={() => onReauthorize(account)}>重新授权</Button>
        </div>
      )}

      <UsageSummary days={usage.days} byOp={usage.by_op} />

      <div className="flex flex-wrap items-center gap-2">
        {!expired && <Button variant="secondary" busy={act.busy} onClick={() => void sync()}>立即同步</Button>}
        {!expired && <Button variant="ghost" onClick={() => onReauthorize(account)}>重新授权</Button>}
        <Button variant="ghost" onClick={() => openTakeover(account.id)}>查看接管简报</Button>
        {syncNote && <span role="status" className="text-xs text-[var(--muted)]">{syncNote}</span>}
      </div>
      {act.error && <ErrorRow message={act.error} />}

      <AuditLog entries={audit} />
      <UnbindConfirm address={account.address} onUnbind={async () => { await careerApi.deleteMailAccount(account.id); onUnbound(); }} />
    </div>
  );
}

/** 打开这个邮箱的接管简报（App 收到聚焦后跳页，简报页挂载时取走 id）。 */
function openTakeover(accountId: string) {
  const event: CareerFocusEvent = { surface: 'takeover', id: accountId };
  emitEvent('career:focus', event);
}

function UsageSummary({ days, byOp }: { days: number; byOp: Record<string, { ok: number; failed: number }> }) {
  const received = (byOp.import?.ok ?? 0) + (byOp.sync?.ok ?? 0);
  const sent = byOp.send?.ok ?? 0;
  const failed = Object.values(byOp).reduce((n, v) => n + v.failed, 0);
  return (
    <section>
      <h3 className="text-xs font-medium text-[var(--muted)]">近 {days} 天</h3>
      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums text-[var(--ink)]">
        <span>收进新邮件 <b>{received}</b> 次</span>
        <span>助理代发 <b>{sent}</b> 封</span>
        <span className={failed ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}>失败 <b>{failed}</b> 次</span>
      </div>
    </section>
  );
}

function auditLine(e: MailAuditEntry): string {
  const d = e.detail ?? {};
  if (e.operation === 'send') {
    const to = Array.isArray(d.to) ? d.to.join('、') : '';
    return `给 ${to}${typeof d.subject_preview === 'string' ? `：「${d.subject_preview}」` : ''}`;
  }
  if (typeof d.fetched === 'number') return `${d.fetched} 封，${typeof d.job_related === 'number' ? d.job_related : 0} 封和求职有关`;
  return typeof d.error === 'string' ? d.error : '';
}

function AuditLog({ entries }: { entries: MailAuditEntry[] }) {
  if (!entries.length) return null;
  return (
    <details className="group border-t border-[var(--line)] pt-3">
      <summary className="cursor-pointer text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)]">谁动过这个邮箱（最近 {entries.length} 条）</summary>
      <ul className="mt-2 grid gap-1.5 text-xs">
        {entries.map(e => (
          <li key={e.id} className="grid grid-cols-[72px_40px_minmax(0,1fr)] gap-2">
            <span className="text-[var(--subtle)]">{relativeTime(e.created_at)}</span>
            <span className="text-[var(--muted)]">{ACTOR[e.actor]}</span>
            <span className={`min-w-0 break-words ${e.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}`}>
              {OPERATION[e.operation] ?? e.operation}{e.status === 'failed' ? '失败' : ''}{auditLine(e) ? ` · ${auditLine(e)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** 解绑要输入邮箱地址确认：删掉授权码后新邮件就收不进来了。 */
function UnbindConfirm({ address, onUnbind }: { address: string; onUnbind: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const act = useCareerAction();
  if (!open) return <Button variant="ghost" size="sm" className="justify-self-start text-[var(--muted)]" onClick={() => setOpen(true)}>解绑这个邮箱</Button>;
  return (
    <section className="grid gap-2 rounded-[10px] border border-[var(--line-2)] px-4 py-3">
      <p className="text-sm text-[var(--ink)]">解绑后授权码立即删除，新邮件不再收进来；已经收进来的申请和记录会保留。输入 <span className="font-mono">{address}</span> 确认。</p>
      <input
        id="mail-unbind-confirm" aria-label="输入邮箱地址确认解绑" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
        className="rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-4 py-1.5 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      />
      <div className="flex gap-2">
        <Button variant="primary" disabled={typed.trim().toLowerCase() !== address} busy={act.busy} onClick={() => void act.run(onUnbind)}>解绑</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setTyped(''); }}>取消</Button>
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </section>
  );
}
