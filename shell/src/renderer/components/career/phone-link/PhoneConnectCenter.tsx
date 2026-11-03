/**
 * 手机连接入口（基本资料「联系方式与账号」里的一行；以后对话里第一次碰到短信码时复用同一个组件）。
 * 没连：「连接手机」一键开始配对；这台电脑配对过的手机直接「用 xxx」。
 * 连了：手机名 + 状态 + 最近一条验证码；出错时给一句怎么办。
 */
import { Smartphone } from 'lucide-react';
import { useState } from 'react';

import { PHONE_TABLE } from '../../../../shared/careerPhone';
import { careerApi } from '../careerApi';
import { Button, ErrorRow, LoadingRow } from '../CareerPrimitives';
import { useCareerAction, useCareerQuery } from '../useCareerData';
import { LatestCode, LinkBadge, linkStateView } from './phoneUi';
import { PhonePairFlow } from './PhonePairFlow';

const TABLES = [PHONE_TABLE] as const;

export function PhoneConnectCenter() {
  const q = useCareerQuery(careerApi.phone, TABLES);
  const action = useCareerAction();
  const [pairing, setPairing] = useState(false);
  const data = q.data;

  if (q.loading && !data) return <LoadingRow />;
  if (q.error) return <ErrorRow message={q.error} onRetry={q.reload} />;
  if (!data) return null;
  const { status, phones, computerName } = data;
  if (!status.platform_supported) return <p className="text-xs text-[var(--muted)]">暂只支持 Mac 电脑</p>;

  const run = (fn: () => Promise<unknown>) => { void action.run(fn).then(() => q.reload()); };
  const binding = status.binding;
  const view = linkStateView(status.state);

  return (
    <div>
      {binding ? (
        <div className="group flex items-center gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] px-3 py-3">
          <Smartphone aria-hidden className="h-5 w-5 shrink-0 text-[var(--muted)]" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--ink)]">{binding.name || '手机'}</span>
              <LinkBadge state={status.state} />
            </span>
            {status.state === 'connected' && status.latest
              ? <LatestCode sms={status.latest} />
              : view && <span className="block text-xs text-[var(--muted)]">{view.hint}</span>}
          </span>
          {view?.retry && <Button size="sm" busy={action.busy} onClick={() => run(() => careerApi.bindPhone(binding))}>重试</Button>}
          {status.state === 'unpaired' && <Button size="sm" onClick={() => run(async () => { await careerApi.unbindPhone(); setPairing(true); })}>重新连接</Button>}
          <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" busy={action.busy} onClick={() => run(careerApi.unbindPhone)}>解除</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setPairing(true)}>连接手机</Button>
          {phones.map(p => (
            <Button key={p.address} busy={action.busy} onClick={() => run(() => careerApi.bindPhone(p))}>用 {p.name || p.address}</Button>
          ))}
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{action.error}</div>}
      {(pairing || status.pairing) && (
        <PhonePairFlow status={status} computerName={computerName} onClose={() => { setPairing(false); q.reload(); }} />
      )}
    </div>
  );
}
