/**
 * 网申控制页：投递总览 + 实时画面 + 当前任务事件 + 队列控制。
 * 页面只保留当前任务需要的信息；业务约束由控件、校验、审批与失败反馈承担。
 */
import { Eye, Pause, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { HANDOFF_REASON_LABELS } from '@/components/career/careerConstants';
import { Button, CareerPage, Card, suggestToChat } from '@/components/career/CareerPrimitives';
import { openBatchPick } from '@/components/career/BatchPickCard';
import { TaskProgressPanel } from '@/components/career/TaskProgressPanel';
import type { BatchState, CareerTakeoverEvent, LiveFrame, LiveSnapshot, LiveStreamEvent, LiveFrameStatus } from '@/components/career/types';
import { liveStatusText } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { useLiveStream } from '@/components/career/useGlobalLive';
import { CareerLiveViewport, liveHumanActive } from '@/components/career/CareerLiveViewport';
import { mailApplicationsOf } from '@/components/career/mail-apply/liveMail';
import { MailLiveList, MailLivePane } from '@/components/career/mail-apply/MailLive';
import { applicationStats, BATCH_ERROR_TEXT, hasBatchWork, statsMeta } from './CareerLiveModel';

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
  const humanActive = liveHumanActive(snapshot?.browser.control, takeover?.state);
  const stats = useMemo(() => applicationStats(applications.data ?? [], handoffs.data ?? 0), [applications.data, handoffs.data]);
  // 邮件投递的申请也在这页：选中一份时画面的位置换成它的邮件（不占浏览器）
  const mailApps = useMemo(() => mailApplicationsOf(applications.data ?? []), [applications.data]);
  const [mailAppId, setMailAppId] = useState<string | null>(null);
  const take = () => action.run(async () => { await careerApi.liveControl('human', 'user_request'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'human' } } : s)); });
  const handback = () => action.run(async () => { await careerApi.liveControl('agent'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'agent' } } : s)); setTakeover(null); handoffs.reload(); });
  const batchCmd = (cmd: 'start' | 'pause' | 'stop') => action.run(async () => { const b = await careerApi.batchCommand(cmd); if (b) setBatch(b); });
  const lastError = batch?.lastError;
  useEffect(() => { if (lastError) console.warn('[career-live] batch lastError', lastError); }, [lastError]);
  const connLabel = stream.status === 'open' ? null : stream.status === 'connecting' ? '连接中…' : '连接断开，自动重连';
  const hasBrowser = !!snapshot?.browser.hasBrowser;
  const working = hasBatchWork(batch);
  const browserStage = working || hasBrowser || !!frame || humanActive;
  // 没有在投、也没有浏览器、也没有邮件投递在办：整页就是一句事实 + 一个动作，不摆空的画面框
  const showStage = browserStage || mailApps.length > 0;
  // 画面的位置：选中的那封邮件；确认只有邮件在办（快照到了、没有浏览器画面）时直接摆第一封，不摆空的画面框
  const mailApp = mailApps.find(a => a.id === mailAppId) ?? (browserStage || !snapshot ? null : mailApps[0] ?? null);
  // 第一份快照到之前不下结论，免得空状态一闪
  const showEmpty = !!snapshot && !showStage;

  return (
    <CareerPage
      title="网申进展"
      meta={statsMeta(stats) || undefined}
      actions={(
        <>
          <Button variant="ghost" onClick={() => suggestToChat('帮我准备这个岗位的网申，链接是：', { surface: 'live' }, 'prefill')}>粘贴岗位链接</Button>
          {!humanActive && hasBrowser && <Button variant="primary" busy={action.busy} onClick={() => void take()}>接管</Button>}
          {humanActive && <Button variant="primary" busy={action.busy} onClick={() => void handback()}>交回，继续</Button>}
        </>
      )}
    >
      {showEmpty && (
        <div data-testid="career-live-empty" className="flex items-center gap-4 px-6 py-8">
          <p className="text-sm text-[var(--ink)]">现在没有在投的</p>
          <Button variant="primary" onClick={() => void openBatchPick()}>去挑一批</Button>
        </div>
      )}
      {showStage && (
      <div className="grid grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-[1fr_340px]">
        {mailApp ? <MailLivePane key={mailApp.id} app={mailApp} onBack={browserStage ? () => setMailAppId(null) : undefined} /> : (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Eye className="h-3.5 w-3.5" />
            {connLabel && <span>{connLabel}</span>}
            {control !== 'none' && <span className={control === 'human' ? 'text-[var(--primary)]' : 'text-[var(--ink-2)]'}>{control === 'human' ? '你在操作' : '助理在操作'}</span>}
            {takeover?.state === 'paused' && <span className="text-[var(--warning)]">等你处理：{(takeover.reason && HANDOFF_REASON_LABELS[takeover.reason]) ?? takeover.reason ?? ''}</span>}
            {snapshot?.browser.url && <span className="min-w-0 flex-1 truncate" title={snapshot.browser.url}>{snapshot.browser.title || snapshot.browser.url}</span>}
          </div>
          <CareerLiveViewport
            frame={frame}
            interactive={humanActive}
            onRequestControl={hasBrowser ? async () => { await take(); return true; } : undefined}
            onInputError={msg => action.run(async () => { throw new Error(msg); })}
            placeholder={frameError ?? (snapshot && !hasBrowser ? '正在打开浏览器…' : '等待画面…')}
          />
          {takeover?.message && takeover.state === 'paused' && (
            <div role="status" className="mt-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--ink)]">{takeover.message}</div>
          )}
          {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
        </div>
        )}
        <div className="space-y-3">
          {/* 只有邮件在办、批量空着时，不再说「现在没有在投的」 */}
          {(working || mailApps.length === 0) && <Card>
            {working ? (
              <>
                <TaskProgressPanel batch={batch} takeover={takeover} />
                {batch?.lastError && <div className="mt-2 text-xs text-[var(--danger)]">{BATCH_ERROR_TEXT}</div>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {batch?.status !== 'running' && <Button variant="primary" busy={action.busy} onClick={() => void batchCmd('start')}><Play className="h-3.5 w-3.5" />开始 / 继续</Button>}
                  {batch?.status === 'running' && <Button busy={action.busy} onClick={() => void batchCmd('pause')}><Pause className="h-3.5 w-3.5" />暂停</Button>}
                  {(batch?.status === 'running' || batch?.status === 'paused') && <Button variant="danger" busy={action.busy} onClick={() => void batchCmd('stop')}><Square className="h-3.5 w-3.5" />停止</Button>}
                </div>
              </>
            ) : (
              <div data-testid="career-live-empty" className="flex items-center gap-3">
                <p className="text-sm text-[var(--ink)]">现在没有在投的</p>
                <Button variant="primary" onClick={() => void openBatchPick()}>去挑一批</Button>
              </div>
            )}
          </Card>}
          {mailApps.length > 0 && <Card><MailLiveList apps={mailApps} selected={mailApp?.id ?? null} onSelect={setMailAppId} /></Card>}
        </div>
      </div>
      )}
    </CareerPage>
  );
}
