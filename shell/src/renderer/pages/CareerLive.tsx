/**
 * 网申控制页：投递总览 + 实时画面 + 当前任务事件 + 队列控制。
 * 页面只保留当前任务需要的信息；业务约束由控件、校验、审批与失败反馈承担。
 */
import { Eye, Pause, Play, Square } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { HANDOFF_REASON_LABELS } from '@/components/career/careerConstants';
import { Button, CareerPage, Card, suggestToChat } from '@/components/career/CareerPrimitives';
import { TaskProgressPanel } from '@/components/career/TaskProgressPanel';
import type { BatchState, CareerTakeoverEvent, LiveFrame, LiveSnapshot, LiveStreamEvent, LiveFrameStatus } from '@/components/career/types';
import { liveStatusText } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { useLiveStream } from '@/components/career/useGlobalLive';
import { CareerLiveViewport } from '@/components/career/CareerLiveViewport';
import { applicationStats } from './CareerLiveModel';

export default function CareerLive() {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [takeover, setTakeover] = useState<CareerTakeoverEvent | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const action = useCareerAction();
  const applications = useCareerQuery(() => careerApi.applications(), ['application']);
  const handoffs = useCareerQuery(() => careerApi.liveState().then(s => s.openHandoffs), ['handoff']);

  const onEvent = useCallback((ev: LiveStreamEvent) => {
    switch (ev.type) {
      case 'frame': setFrame(ev as LiveFrame); setFrameError(null); return;
      case 'snapshot': { const s = ev as LiveStreamEvent & LiveSnapshot; setSnapshot(s); if (s.batch) setBatch(s.batch); return; }
      case 'frame-error': setFrameError(String((ev as { error: string }).error)); return;
      case 'frame-status': { const st = ev as unknown as LiveFrameStatus; if (st.state !== 'connecting') setFrame(null); setFrameError(liveStatusText(st)); return; }
      case 'career:batch': setBatch(ev as unknown as BatchState); return;
      case 'career:takeover': setTakeover(ev as unknown as CareerTakeoverEvent); return;
      default: return;
    }
  }, []);
  const stream = useLiveStream(true, onEvent);

  const control = snapshot?.browser.control ?? 'none';
  const humanActive = control === 'human' || takeover?.state === 'human_active';
  const stats = useMemo(() => applicationStats(applications.data ?? [], handoffs.data ?? 0), [applications.data, handoffs.data]);
  const take = () => action.run(async () => { await careerApi.liveControl('human', 'user_request'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'human' } } : s)); });
  const handback = () => action.run(async () => { await careerApi.liveControl('agent'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'agent' } } : s)); setTakeover(null); handoffs.reload(); });
  const batchCmd = (cmd: 'start' | 'pause' | 'stop') => action.run(async () => { const b = await careerApi.batchCommand(cmd); if (b) setBatch(b); });
  const connLabel = stream.status === 'open' ? (frame ? '直播中' : '已连接，等待画面') : stream.status === 'connecting' ? '连接中…' : '连接断开，自动重连';

  return (
    <CareerPage
      title="网申助手"
      subtitle="查看投递进展，处理需要你接手的步骤"
      actions={(
        <>
          <Button variant="ghost" onClick={() => suggestToChat('帮我准备这个岗位的网申，链接是：', { surface: 'live' }, 'prefill')}>粘贴岗位链接</Button>
          {!humanActive && <Button variant="primary" busy={action.busy} disabled={!snapshot?.browser.hasBrowser} onClick={() => void take()}>接管</Button>}
          {humanActive && <Button variant="primary" busy={action.busy} onClick={() => void handback()}>交回，继续</Button>}
          <Button variant="ghost" onClick={() => emitEvent('career:focus', { surface: 'today' })}>今日</Button>
        </>
      )}
    >
      <div className="grid grid-cols-2 gap-3 px-4 pt-3 sm:grid-cols-5" aria-label="投递总览">
        {[
          ['总任务', stats.total], ['进行中', stats.active], ['等你处理', stats.waiting], ['已投出', stats.submitted], ['已关闭', stats.closed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
            <div className="text-xs text-[var(--muted)]">{label}</div>
            <div className="mt-0.5 text-xl font-semibold text-[var(--ink)]">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 px-4 py-3 lg:grid-cols-[1fr_340px]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Eye className="h-3.5 w-3.5" />
            <span>{connLabel}</span>
            <span className={control === 'human' ? 'text-[var(--primary)]' : 'text-[var(--success)]'}>{control === 'human' ? '你在操作' : control === 'agent' ? '助理在操作' : '浏览器未打开'}</span>
            {takeover?.state === 'paused' && <span className="text-[var(--warning)]">等你处理：{(takeover.reason && HANDOFF_REASON_LABELS[takeover.reason]) ?? takeover.reason ?? ''}</span>}
            {snapshot?.browser.url && <span className="min-w-0 flex-1 truncate" title={snapshot.browser.url}>{snapshot.browser.title || snapshot.browser.url}</span>}
          </div>
          <CareerLiveViewport
            frame={frame}
            interactive={humanActive}
            onRequestControl={snapshot?.browser.hasBrowser ? async () => { await take(); return true; } : undefined}
            onInputError={msg => action.run(async () => { throw new Error(msg); })}
            placeholder={frameError ?? (snapshot && !snapshot.browser.hasBrowser ? '浏览器还没有打开。粘贴岗位链接后，画面会在这里出现。' : '等待画面…')}
          />
          {takeover?.message && takeover.state === 'paused' && (
            <div role="status" className="mt-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--ink)]">{takeover.message}</div>
          )}
          {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
        </div>
        <div className="space-y-3">
          <Card>
            <TaskProgressPanel batch={batch} takeover={takeover} />
            {batch?.lastError && <div className="mt-2 text-xs text-[var(--danger)]">{batch.lastError}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              {batch?.status !== 'running' && <Button variant="primary" busy={action.busy} onClick={() => void batchCmd('start')}><Play className="h-3.5 w-3.5" />开始 / 继续</Button>}
              {batch?.status === 'running' && <Button busy={action.busy} onClick={() => void batchCmd('pause')}><Pause className="h-3.5 w-3.5" />暂停</Button>}
              {(batch?.status === 'running' || batch?.status === 'paused') && <Button variant="danger" busy={action.busy} onClick={() => void batchCmd('stop')}><Square className="h-3.5 w-3.5" />停止</Button>}
            </div>
          </Card>
        </div>
      </div>
    </CareerPage>
  );
}
