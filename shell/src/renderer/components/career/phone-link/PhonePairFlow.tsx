/**
 * 连接手机的弹窗：打开时就开始等配对（服务端同时打开系统蓝牙设置），手机上点三下；
 * 配上、连上短信后显示最近一条验证码作为证明。苹果、安卓同一套步骤（都走蓝牙读短信）。
 * 状态全部来自服务端（phone_link 表变化时由父组件刷新），这里不自己推断。
 */
import { CheckCircle2, Loader2, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import type { PhoneStatus } from '../../../../shared/careerPhone';
import { careerApi } from '../careerApi';
import { Button } from '../CareerPrimitives';
import { useCareerAction } from '../useCareerData';
import { LatestCode, linkStateView } from './phoneUi';

/** 与 className 里的 z-[70] 一致（Tailwind 只认字面量类名）。 */
const Z = 70;

export function PhonePairFlow({ status, computerName, onClose }: { status: PhoneStatus; computerName: string; onClose: () => void }) {
  const action = useCareerAction();
  const started = useRef(false);
  const linked = !!status.binding;
  const done = linked && status.state === 'connected';

  useEffect(() => {
    if (started.current || linked) return;
    started.current = true;
    void action.run(careerApi.startPhonePairing);
  }, [action, linked]);

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
            : linked ? <Linking status={status} />
              : <Steps computerName={computerName} />}
          {action.error && <div role="alert" className="mt-3 text-xs text-[var(--danger)]">{action.error}</div>}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function Steps({ computerName }: { computerName: string }) {
  const steps = [
    <>打开手机「设置 → 蓝牙」，点 <b className="text-[var(--ink)]">{computerName || '这台电脑'}</b></>,
    <>两边数字一样：手机点「配对」，电脑点「连接」</>,
    <>手机问能否访问短信或显示通知，点「允许」</>,
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
      <p className="text-sm text-[var(--ink)]">已和 <b>{status.binding?.name || '手机'}</b> 配对，正在连接短信…</p>
      {view && <p className="text-xs text-[var(--muted)]">{view.hint}</p>}
    </div>
  );
}

function Connected({ status, onDone }: { status: PhoneStatus; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-[var(--ink)]">
        <CheckCircle2 aria-hidden className="h-5 w-5 text-[var(--success)]" />
        连上了 <b>{status.binding?.name || '手机'}</b>，网申的短信验证码以后自动填
      </p>
      {status.latest && <LatestCode sms={status.latest} />}
      <div className="flex justify-end"><Button variant="primary" onClick={onDone}>好</Button></div>
    </div>
  );
}
