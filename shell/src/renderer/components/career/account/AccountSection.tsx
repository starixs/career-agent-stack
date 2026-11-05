/**
 * 设置 › 账号与用量：积分余额、最近 30 天用在哪、积分流水、计费清单。
 * 数据来自 /api/career/billing/*；账号与充值上线前只有本机账本，余额到 0 也不拦用户。
 */
import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import { careerPath } from '../careerApi';
import { Button, Card, ErrorRow, LoadingRow, relativeTime } from '../CareerPrimitives';
import { useCareerAction, useCareerQuery } from '../useCareerData';
import { fillDays, groupUsage, txnLabel, type BillingSummary, type CreditTxn, type PriceList } from './accountModel';
import { PriceListCard } from './PriceListCard';

const BILLING_TABLES = ['credit_account', 'credit_transaction', 'billing_usage'] as const;

export function AccountSection() {
  const summary = useCareerQuery(() => apiGetJson<{ summary: BillingSummary }>(careerPath('/billing/summary')).then(r => r.summary), BILLING_TABLES);
  const prices = useCareerQuery(() => apiGetJson<{ priceList: PriceList }>(careerPath('/billing/price-list')).then(r => r.priceList));
  const act = useCareerAction();
  const checkin = () => act.run(async () => {
    await apiPostJson(careerPath('/billing/checkin'), {});
    summary.reload();
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-8 py-8">
      <h2 className="font-[family-name:var(--font-human)] text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">账号与用量</h2>
      {summary.error && <ErrorRow message={summary.error} onRetry={summary.reload} />}
      {!summary.data && !summary.error && <LoadingRow />}
      {summary.data && (
        <>
          <BalanceCard data={summary.data} onCheckin={() => void checkin()} busy={act.busy} />
          {act.error && <ErrorRow message={act.error} />}
          <UsageCard data={summary.data} />
          <RecentCard rows={summary.data.recent} />
        </>
      )}
      {prices.data && <PriceListCard list={prices.data} />}
    </div>
  );
}

function BalanceCard({ data, onCheckin, busy }: { data: BillingSummary; onCheckin: () => void; busy: boolean }) {
  const sub = data.account.subscription_credits;
  return (
    <Card>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[length:var(--text-xs)] text-[var(--muted)]">积分余额</div>
          <div className="text-[length:var(--text-2xl)] font-semibold tabular-nums text-[var(--ink)]">{data.balance}</div>
          {sub > 0 && <div className="text-[length:var(--text-xs)] text-[var(--muted)]">其中套餐积分 {sub}</div>}
        </div>
        <Button variant="primary" busy={busy} onClick={onCheckin}>今日签到</Button>
      </div>
    </Card>
  );
}

function UsageCard({ data }: { data: BillingSummary }) {
  const days = fillDays(data.daily, data.windowDays);
  const peak = Math.max(1, ...days.map(d => d.credits));
  const groups = groupUsage(data.buckets);
  const top = Math.max(1, ...groups.map(g => g.credits));
  return (
    <Card title={`最近 ${data.windowDays} 天用了 ${data.spentInWindow} 积分`}>
      <div className="flex h-16 items-end gap-[2px]" aria-label="每天用量">
        {days.map(d => (
          <div key={d.day} title={`${d.day}：${d.credits} 积分`} className="flex-1 rounded-t-sm bg-[var(--primary-muted)]" style={{ height: `${Math.max(d.credits > 0 ? 8 : 2, (d.credits / peak) * 100)}%` }} />
        ))}
      </div>
      <ul className="mt-4 space-y-2">
        {groups.map(g => (
          <li key={g.id} className="grid grid-cols-[7rem_1fr_6rem] items-center gap-3 text-[length:var(--text-sm)]">
            <span className="text-[var(--ink)]">{g.label}</span>
            <span className="h-2 rounded-full bg-[var(--inset)]"><span className="block h-2 rounded-full bg-[var(--primary)]" style={{ width: `${(g.credits / top) * 100}%` }} /></span>
            <span className="text-right tabular-nums text-[var(--muted)]">{g.credits} 积分 · {g.calls} 次</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RecentCard({ rows }: { rows: CreditTxn[] }) {
  if (rows.length === 0) return null;
  return (
    <Card title="积分流水">
      <ul className="divide-y divide-[var(--line)]">
        {rows.map(t => (
          <li key={t.id} className="flex items-center justify-between py-2 text-[length:var(--text-sm)]">
            <span className="text-[var(--ink)]">{txnLabel(t)}</span>
            <span className="flex items-center gap-3">
              <span className="text-[length:var(--text-xs)] text-[var(--muted)]">{relativeTime(t.created_at)}</span>
              <span className={`w-14 text-right tabular-nums ${t.amount > 0 ? 'text-[var(--success)]' : 'text-[var(--ink)]'}`}>{t.amount > 0 ? `+${t.amount}` : t.amount}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
