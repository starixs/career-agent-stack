/**
 * 浏览器现场：实时画面（Global 侧车 CDP screencast 推帧）+ 浏览器控制权 + 批量投递进度与控制。
 * 关掉这个页签不影响后台：批量运行器在 Global 侧车里跑，画面流只是"看"。
 */
import { Eye, Pause, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { HANDOFF_REASON_LABELS } from '@/components/career/careerConstants';
import { Badge, Button, CareerPage, Card, SectionTitle, type BadgeTone } from '@/components/career/CareerPrimitives';
import type { BatchState, LiveFrame, LiveSnapshot, LiveStreamEvent } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import { useLiveStream } from '@/components/career/useGlobalLive';
import { CareerLiveViewport } from '@/components/career/CareerLiveViewport';

const BATCH_LABELS: Record<BatchState['status'], string> = { idle: '空闲', running: '运行中', paused: '已暂停', stopped: '已停止' };
const BATCH_TONES: Record<BatchState['status'], BadgeTone> = { idle: 'neutral', running: 'success', paused: 'warning', stopped: 'neutral' };
const PHASE_LABELS: Record<string, string> = { picking: '挑选下一份', driving: '填写中', waiting_user: '等你处理', waiting_control: '你在接管', pacing: '间歇', rate_locked: '风控冷却', daily_cap: '今日上限' };

export function batchSummaryLine(b: BatchState | null | undefined): string {
  if (!b) return '还没有批量任务';
  const parts = [`已填好 ${b.done}`, `失败 ${b.failed}`, `等你处理 ${b.handoffs}`, `队列 ${b.queued}`, `今日 ${b.todayCount}`];
  return parts.join(' · ');
}

export default function CareerLive() {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [takeover, setTakeover] = useState<{ state: string; reason?: string; message?: string } | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const action = useCareerAction();
  const handoffs = useCareerQuery(() => careerApi.liveState().then(s => s.openHandoffs), ['handoff']);

  const onEvent = useCallback((ev: LiveStreamEvent) => {
    switch (ev.type) {
      case 'frame': setFrame(ev as LiveFrame); setFrameError(null); setFrameCount(n => n + 1); return;
      case 'snapshot': { const s = ev as LiveStreamEvent & LiveSnapshot; setSnapshot(s); if (s.batch) setBatch(s.batch); return; }
      case 'frame-error': setFrameError(String((ev as { error: string }).error)); return;
      case 'career:batch': setBatch(ev as unknown as BatchState); return;
      case 'career:takeover': { const t = ev as unknown as { state: string; reason?: string; message?: string }; setTakeover(t); return; }
      default: return;
    }
  }, []);
  const stream = useLiveStream(true, onEvent);

  useEffect(() => {
    const timer = setInterval(() => { setFps(frameCount); setFrameCount(0); }, 1000);
    return () => clearInterval(timer);
  }, [frameCount]);

  const control = snapshot?.browser.control ?? 'none';
  const humanActive = control === 'human' || takeover?.state === 'human_active';
  const take = () => action.run(async () => { await careerApi.liveControl('human', 'user_request'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'human' } } : s)); });
  const handback = () => action.run(async () => { await careerApi.liveControl('agent'); setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: 'agent' } } : s)); setTakeover(null); handoffs.reload(); });
  const batchCmd = (cmd: 'start' | 'pause' | 'stop') => action.run(async () => { const b = await careerApi.batchCommand(cmd); if (b) setBatch(b); });

  const connLabel = useMemo(() => (stream.status === 'open' ? (frame ? `直播中 · ${fps} fps` : '已连接，等待画面') : stream.status === 'connecting' ? '连接中…' : `连接断开${stream.detail ? `：${stream.detail}` : ''}，自动重连`), [stream.status, stream.detail, frame, fps]);

  return (
    <CareerPage
      title="浏览器现场"
      subtitle="看助理在浏览器里做什么。关掉这一页不影响后台继续跑。"
      examples={['开始批量投递', '暂停批量投递', '现在填到哪了？']}
      actions={(
        <>
          {!humanActive && <Button variant="primary" busy={action.busy} disabled={!snapshot?.browser.hasBrowser} onClick={() => void take()}>接管</Button>}
          {humanActive && <Button variant="primary" busy={action.busy} onClick={() => void handback()}>交回，继续</Button>}
          <Button variant="ghost" onClick={() => emitEvent('career:focus', { surface: 'today' })}>今日</Button>
        </>
      )}
    >
      <div className="grid grid-cols-1 gap-4 px-4 py-3 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            <Eye className="h-3.5 w-3.5" />
            <span>{connLabel}</span>
            <Badge tone={control === 'human' ? 'info' : control === 'agent' ? 'success' : 'neutral'}>{control === 'human' ? '你在操作' : control === 'agent' ? '助理在操作' : '浏览器未打开'}</Badge>
            {takeover?.state === 'paused' && <Badge tone="warning">等你处理：{(takeover.reason && HANDOFF_REASON_LABELS[takeover.reason]) ?? takeover.reason ?? ''}</Badge>}
            {snapshot?.browser.url && <span className="min-w-0 flex-1 truncate" title={snapshot.browser.url}>{snapshot.browser.title || snapshot.browser.url}</span>}
          </div>
          <CareerLiveViewport
            frame={frame}
            interactive={humanActive}
            onRequestControl={snapshot?.browser.hasBrowser ? async () => { await take(); return true; } : undefined}
            onInputError={msg => action.run(async () => { throw new Error(msg); })}
            placeholder={frameError ?? (snapshot && !snapshot.browser.hasBrowser ? '浏览器还没有打开。让助理开始填表，或在右侧开始批量投递，画面就会出现。' : '等待画面…')}
          />
          {takeover?.message && takeover.state === 'paused' && (
            <div role="status" className="mt-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--ink)]">{takeover.message}</div>
          )}
          <p className="mt-2 text-xs text-[var(--ink-subtle)]">{humanActive ? '你已接管：直接在画面里点、输入、滚动，真实 Chrome 同步执行；做完点「交回，继续」，助理从当前页接着填。' : '遇到登录、滑块、短信码时直接点画面即可接管，然后在画面里操作；浏览器一直留在产品里。'}</p>
          {action.error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{action.error}</div>}
        </div>
        <div className="space-y-3">
          <Card title="批量投递" extra={batch ? <Badge tone={BATCH_TONES[batch.status]}>{BATCH_LABELS[batch.status]}</Badge> : undefined}>
            <div className="text-xs text-[var(--ink-muted)]">{batchSummaryLine(batch)}</div>
            {batch?.phase && <div className="mt-1 text-xs text-[var(--ink-muted)]">阶段：{PHASE_LABELS[batch.phase] ?? batch.phase}</div>}
            {batch?.message && <div className="mt-1 text-sm text-[var(--ink)]">{batch.message}</div>}
            {batch?.currentTitle && <div className="mt-1 text-xs text-[var(--ink-subtle)]">当前：{batch.currentTitle}</div>}
            {batch?.lastError && <div className="mt-1 text-xs text-[var(--error)]">最近错误：{batch.lastError}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              {batch?.status !== 'running' && <Button variant="primary" busy={action.busy} onClick={() => void batchCmd('start')}><Play className="h-3.5 w-3.5" />开始 / 继续</Button>}
              {batch?.status === 'running' && <Button busy={action.busy} onClick={() => void batchCmd('pause')}><Pause className="h-3.5 w-3.5" />暂停</Button>}
              {(batch?.status === 'running' || batch?.status === 'paused') && <Button variant="danger" busy={action.busy} onClick={() => void batchCmd('stop')}><Square className="h-3.5 w-3.5" />停止</Button>}
            </div>
            <p className="mt-2 text-xs text-[var(--ink-subtle)]">队列 = 「岗位与投递」里你已批准的填表动作。运行器在后台一份份填，遇到登录 / 验证码停下等你，交回后自动继续；两份之间会像真人一样停一会。</p>
          </Card>
          <SectionTitle>等你处理（{handoffs.data ?? 0}）</SectionTitle>
          <div className="text-xs text-[var(--ink-muted)]">
            {(handoffs.data ?? 0) > 0 ? '浏览器里有需要你本人完成的步骤（登录 / 验证码 / 测评）。点「接管」操作，完成后点「交回，继续」。' : '没有等待处理的接管。'}
          </div>
        </div>
      </div>
    </CareerPage>
  );
}
