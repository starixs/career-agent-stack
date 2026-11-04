/** 手机连接入口：设备记忆是持久选择，当前连接是可恢复的临时状态。 */
import { Smartphone } from 'lucide-react';
import { useState } from 'react';

import { PHONE_TABLE, type PhoneStatus } from '../../../../shared/careerPhone';
import { careerApi } from '../careerApi';
import { Button, ErrorRow, LoadingRow } from '../CareerPrimitives';
import { useCareerAction, useCareerQuery } from '../useCareerData';
import { LatestCode, LinkBadge, linkStateView } from './phoneUi';
import { PhonePairFlow } from './PhonePairFlow';

const TABLES = [PHONE_TABLE] as const;

export function PhoneConnectCenter() {
  const q = useCareerQuery(careerApi.phone, TABLES);
  const action = useCareerAction();
  const [pairing, setPairing] = useState<'new' | 'repair' | null>(null);
  const data = q.data;
  if (q.loading && !data) return <LoadingRow />;
  if (q.error) return <ErrorRow message={q.error} onRetry={q.reload} />;
  if (!data) return null;
  const { status, phones, computerName } = data;
  if (!status.platform_supported) return <p className="text-xs text-[var(--muted)]">暂只支持 Mac 电脑</p>;
  const run = (fn: () => Promise<unknown>) => { void action.run(fn).then(() => q.reload()); };
  return (
    <div>
      {status.binding ? <RememberedPhone status={status} busy={action.busy}
        onRetry={() => run(careerApi.reconnectPhone)} onForget={() => run(careerApi.unbindPhone)}
        onRepair={() => setPairing('repair')} /> : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setPairing('new')}>连接手机</Button>
          {phones.map(p => <Button key={p.address} busy={action.busy}
            onClick={() => run(() => careerApi.bindPhone(p))}>用 {p.name || '这台手机'}</Button>)}
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{action.error}</div>}
      {(pairing || status.pairing) && <PhonePairFlow status={status} phones={phones} computerName={computerName}
        repair={pairing === 'repair'} onRefresh={q.reload} onClose={() => { setPairing(null); q.reload(); }} />}
    </div>
  );
}

interface RememberedProps {
  status: PhoneStatus; busy: boolean; onRetry: () => void; onForget: () => void; onRepair: () => void;
}

function RememberedPhone({ status, busy, onRetry, onForget, onRepair }: RememberedProps) {
  const binding = status.binding;
  if (!binding) return null;
  const view = linkStateView(status.state);
  return (
    <div className="group flex items-center gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] px-3 py-3">
      <Smartphone aria-hidden className="h-5 w-5 shrink-0 text-[var(--muted)]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--ink)]">{binding.name || '手机'}</span>
          <LinkBadge state={status.state} />
        </span>
        <span className="block text-xs text-[var(--subtle)]">已记住此手机 · {binding.last_connected_at ? '无需重新配对' : '首次需确认消息权限'}</span>
        {status.state === 'connected' && status.latest ? <LatestCode sms={status.latest} />
          : view && <span className="block text-xs text-[var(--muted)]">{view.hint}</span>}
      </span>
      {view?.retry && <Button size="sm" busy={busy} onClick={onRetry}>{status.state === 'paused' ? '重新连接' : '重试'}</Button>}
      {status.state !== 'connected' && <Button size="sm" busy={busy} onClick={onRepair}>
        {status.state === 'unpaired' ? '修复配对' : '连接帮助'}</Button>}
      <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        busy={busy} onClick={onForget}>不再使用</Button>
    </div>
  );
}
