/**
 * 首次选择 / 配对与修复帮助。已有配对先直连，只有新设备才进入系统配对。
 * 记忆保留在服务端；真正读到短信服务后才显示成功。
 * 状态全部来自服务端（phone_link 表变化时由父组件刷新），这里不自己推断。
 */
import { CheckCircle2, Loader2, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import type { PairedPhone, PhoneStatus } from '../../../../shared/careerPhone';
import { careerApi } from '../careerApi';
import { Button } from '../CareerPrimitives';
import { useCareerAction } from '../useCareerData';
import { LatestCode, linkStateView } from './phoneUi';

/** 与 className 里的 z-[70] 一致（Tailwind 只认字面量类名）。 */
const Z = 70;

interface Props {
  status: PhoneStatus; phones: PairedPhone[]; computerName: string; repair: boolean;
  onRefresh: () => void; onClose: () => void;
}

export function PhonePairFlow({ status, phones, computerName, repair, onRefresh, onClose }: Props) {
  const action = useCareerAction();
  const [newDevice, setNewDevice] = useState(phones.length === 0 || status.pairing || repair);
  const started = useRef(false);
  const linked = !!status.binding;
  const done = linked && status.state === 'connected';

  useEffect(() => {
    if (started.current || (linked && !repair) || !newDevice) return;
    started.current = true;
    void action.run(careerApi.startPhonePairing);
  }, [action, linked, repair, newDevice]);

  const close = useCallback(() => {
    if (!linked) void careerApi.cancelPhonePairing().catch((error: unknown) => console.warn('[phone-link] 取消配对失败:', error));
    onClose();
  }, [linked, onClose]);
  useCloseLayer(() => { close(); return true; }, Z);

  return (
    <OverlayBackdrop onClose={close} className="z-[70] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label="连接手机" className="flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">
        <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3">
          <Smartphone aria-hidden className="h-5 w-5 text-[var(--muted)]" />
          <h2 className="flex-1 font-human text-lg font-semibold text-[var(--ink)]">连接手机</h2>
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><X className="h-4 w-4" /></button>
        </header>
        <div className="overflow-y-auto px-6 py-5">
          {done ? <Connected status={status} onDone={onClose} />
            : linked && !repair ? <Linking status={status} />
              : newDevice ? <Steps computerName={computerName} />
                : <PhoneChoices phones={phones} busy={action.busy} onNew={() => setNewDevice(true)}
                  onUse={phone => { void action.run(async () => { await careerApi.bindPhone(phone); onRefresh(); }); }} />}
          {action.error && <div role="alert" className="mt-3 text-xs text-[var(--danger)]">{action.error}</div>}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function PhoneChoices({ phones, busy, onUse, onNew }: {
  phones: PairedPhone[]; busy: boolean; onUse: (phone: PairedPhone) => void; onNew: () => void;
}) {
  return <div className="space-y-3">
    <p className="text-sm text-[var(--muted)]">这些手机已经配对过，直接选择，不必重新配对。</p>
    <div className="flex flex-wrap gap-2">{phones.map(phone => <Button key={phone.address} busy={busy}
      onClick={() => onUse(phone)}>用 {phone.name || '这台手机'}</Button>)}</div>
    <Button variant="ghost" busy={busy} onClick={onNew}>连接其他手机</Button>
  </div>;
}

function Steps({ computerName }: { computerName: string }) {
  const steps = [
    <>打开手机「设置 → 蓝牙」，点 <b className="text-[var(--ink)]">{computerName || '这台电脑'}</b></>,
    <>两边数字一样：手机点「配对」，电脑点「连接」</>,
    <>配对后请保持手机解锁：小米弹「消息权限申请」时点「是」；其他手机的短信访问请求点「允许」</>,
  ];
  return (
    <div>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm text-[var(--muted)]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--hover)] text-xs font-semibold text-[var(--ink)]">{i + 1}</span>
            <span className="pt-0.5">{s}</span>
          </li>
        ))}
      </ol>
      <p className="mt-5 flex items-center gap-2 text-xs text-[var(--subtle)]">
        <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />等手机连上…电脑的蓝牙设置已经打开，先别关
      </p>
    </div>
  );
}

function Linking({ status }: { status: PhoneStatus }) {
  const view = linkStateView(status.state);
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--ink)]"><b>{status.binding?.name || '手机'}</b>：{view?.label || '等待连接'}</p>
      {view && <p className="text-xs text-[var(--muted)]">{view.hint}</p>}
    </div>
  );
}

function Connected({ status, onDone }: { status: PhoneStatus; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-[var(--ink)]">
        <CheckCircle2 aria-hidden className="h-5 w-5 text-[var(--success)]" />
        <b>{status.binding?.name || '手机'}</b> 的短信服务已接通
      </p>
      <p className="text-sm text-[var(--muted)]">已记住这台手机，无需重新配对。断线恢复最多尝试 2 分钟，之后休眠；需要收码时再唤醒。</p>
      {status.latest && <LatestCode sms={status.latest} />}
      <div className="flex justify-end"><Button variant="primary" onClick={onDone}>好</Button></div>
    </div>
  );
}
