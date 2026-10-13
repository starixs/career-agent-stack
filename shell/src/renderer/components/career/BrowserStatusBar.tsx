/**
 * 岗位与投递页顶部常驻的「浏览器状态条」。
 * 订阅 eventBus 的 career:takeover（由 TabProvider 转发），显示 running / paused(原因) / human_active / resuming。
 * 「接管 / 交回」优先通过 eventBus 交给当前会话的 Chat Tab 走 Session 路由；
 * 1.5s 内无人处理则降级为 Global 路由 POST /api/career/browser/control。
 */
import { Globe } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';

import { careerApi } from './careerApi';
import { HANDOFF_REASON_LABELS, TAKEOVER_STATE_LABELS } from './careerConstants';
import { Badge, Button, type BadgeTone } from './CareerPrimitives';
import type { CareerTakeoverEvent } from './types';

const HANDLED_TIMEOUT_MS = 1500;
let requestSeq = 0;

/** 请求 Chat Tab 执行接管动作；超时则走 Global 降级。返回是否成功。 */
export function dispatchTakeoverAction(runId: string, action: 'take' | 'handback'): Promise<boolean> {
  const requestId = `takeover-${Date.now()}-${++requestSeq}`;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(ok);
    };
    const off = onEvent<{ requestId: string; ok: boolean }>('career:takeover-handled', payload => {
      if (payload?.requestId === requestId) finish(Boolean(payload.ok));
    });
    const timer = setTimeout(() => {
      if (settled) return;
      // 没有 Chat Tab 认领（例如批量运行器的 run 不在 Session 的注册表里）：走免令牌的 Global 现场控制接口
      careerApi.liveControl(action === 'take' ? 'human' : 'agent', action === 'take' ? 'user_request' : undefined)
        .then(() => finish(true))
        .catch(() => finish(false));
    }, HANDLED_TIMEOUT_MS);
    emitEvent('career:takeover-action', { requestId, runId, action });
  });
}

const STATE_TONES: Record<string, BadgeTone> = {
  idle: 'neutral', running: 'success', paused: 'warning', human_active: 'info', resuming: 'accent',
};

/** hideWhenIdle：没有浏览器任务时整条不占位（岗位收藏页用，表格是主体）；一旦运行 / 停下等你接管就出现。 */
export function BrowserStatusBar({ hideWhenIdle = false }: { hideWhenIdle?: boolean } = {}) {
  const [takeover, setTakeover] = useState<CareerTakeoverEvent | null>(null);
  const [busy, setBusy] = useState<'take' | 'handback' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => onEvent<CareerTakeoverEvent>('career:takeover', payload => {
    if (payload?.runId) setTakeover(payload);
  }), []);

  const act = useCallback(async (action: 'take' | 'handback') => {
    if (!takeover) return;
    setBusy(action);
    setNotice(null);
    const ok = await dispatchTakeoverAction(takeover.runId, action);
    if (!mountedRef.current) return;
    setBusy(null);
    if (ok) {
      setTakeover(prev => (prev ? { ...prev, state: action === 'take' ? 'human_active' : 'resuming' } : prev));
      // 接管后在聊天旁的现场抽屉里直接操作（不能 import CareerLiveDrawer：它反向依赖本文件）
      if (action === 'take') emitEvent('career:live-drawer', { open: true });
      // 交回后的"继续"由会话的接管交接统一发给助理（只对对话里发起的填写；后台批量自己续跑）
    } else {
      setNotice('操作失败，请稍后重试');
    }
  }, [takeover]);

  const state = takeover?.state ?? 'idle';
  const reason = takeover?.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;

  if (hideWhenIdle && state === 'idle' && !notice) return null;
  return (
    <div data-testid="browser-status-bar" className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--inset)] px-4 py-2 text-xs text-[var(--muted)]">
      <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span>浏览器</span>
      <Badge tone={STATE_TONES[state] ?? 'neutral'}>{TAKEOVER_STATE_LABELS[state] ?? state}</Badge>
      {state === 'paused' && <span>原因：{reason ?? '未知'}</span>}
      {takeover?.message && <span className="truncate">{takeover.message}</span>}
      {state === 'idle' && <span className="text-[var(--subtle)]">没有进行中的浏览器任务</span>}
      {notice && <span role="alert" className="text-[var(--danger)]">{notice}</span>}
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" onClick={() => emitEvent('career:live-drawer', { open: true })}>浏览器现场</Button>
        {state === 'paused' && (
          <Button variant="primary" busy={busy === 'take'} disabled={busy !== null} onClick={() => void act('take')}>接管</Button>
        )}
        {(state === 'human_active' || state === 'paused') && (
          <Button busy={busy === 'handback'} disabled={busy !== null} onClick={() => void act('handback')}>交回</Button>
        )}
      </div>
    </div>
  );
}
