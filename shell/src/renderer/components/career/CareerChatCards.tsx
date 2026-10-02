/**
 * 对话内求职卡片：待审核动作 / 浏览器需要你 / 可折叠进度行。
 * 状态来自 TabContext（TabProvider 处理 career:* SSE），回传走 Session 路由。
 * 在 TabProvider 之外渲染时返回 null，MessageList 的既有测试不受影响。
 */
import { ChevronDown, ChevronRight, Globe, ListChecks, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { useOpenWebLink } from '@/context/BrowserPanelContext';
import { useTabStateOptional } from '@/context/TabContext';

import { ACTION_KIND_LABELS, HANDOFF_REASON_LABELS, TAKEOVER_STATE_LABELS } from './careerConstants';
import { Badge, Button } from './CareerPrimitives';
import type { ActionKind, CareerProgressEvent, CareerReviewEvent, CareerTakeoverEvent } from './types';

export function CareerChatCards() {
  const tab = useTabStateOptional();
  if (!tab) return null;
  const { pendingCareerReview, careerTakeover, careerProgress } = tab;
  if (!pendingCareerReview && !careerTakeover && !careerProgress) return null;
  return (
    <div className="space-y-2 py-2">
      {careerProgress && <CareerProgressRow progress={careerProgress} onDismiss={tab.dismissCareerProgress} />}
      {careerTakeover && careerTakeover.state !== 'running' && (
        <CareerTakeoverCard takeover={careerTakeover} onAction={tab.requestCareerTakeover} />
      )}
      {pendingCareerReview && <CareerReviewCard review={pendingCareerReview} onDecision={tab.respondCareerReview} />}
    </div>
  );
}

export function CareerReviewCard({ review, onDecision }: {
  review: CareerReviewEvent;
  onDecision: (actionIds: string[], decision: 'approved' | 'rejected') => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    setError(null);
    const ok = await onDecision(review.actionIds, decision);
    if (!ok) setError('回传失败，请重试');
    setBusy(null);
  };
  const kindLabel = ACTION_KIND_LABELS[review.kind as ActionKind] ?? review.kind;
  return (
    <div data-testid="career-review-card" className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
          <ListChecks className="size-4 text-[var(--accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="accent">待审核</Badge>
            <Badge>{kindLabel}</Badge>
            <span className="text-xs text-[var(--ink-muted)]">{review.actionIds.length} 个动作</span>
          </div>
          <div className="mt-1 text-sm text-[var(--ink)]">{review.summary}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-[var(--ink-muted)]">提交与发送永远需要你批准后才会执行。</div>
      {error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{error}</div>}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" busy={busy === 'approved'} disabled={busy !== null} onClick={() => void decide('approved')}>批准</Button>
        <Button variant="danger" busy={busy === 'rejected'} disabled={busy !== null} onClick={() => void decide('rejected')}>拒绝</Button>
      </div>
    </div>
  );
}

export function CareerTakeoverCard({ takeover, onAction }: {
  takeover: CareerTakeoverEvent;
  onAction: (runId: string, action: 'take' | 'handback') => Promise<boolean>;
}) {
  const openWebLink = useOpenWebLink();
  const [busy, setBusy] = useState<'take' | 'handback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'take' | 'handback') => {
    setBusy(action);
    setError(null);
    const ok = await onAction(takeover.runId, action);
    if (!ok) setError('操作失败，请重试');
    setBusy(null);
  };
  const reason = takeover.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;
  const stateLabel = TAKEOVER_STATE_LABELS[takeover.state] ?? takeover.state;
  const tone = takeover.state === 'paused' ? 'warning' : takeover.state === 'human_active' ? 'info' : 'neutral';
  return (
    <div data-testid="career-takeover-card" className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--warning-bg)]">
          <Globe className="size-4 text-[var(--warning)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">浏览器需要你</span>
            <Badge tone={tone}>{stateLabel}</Badge>
          </div>
          <div className="mt-1 text-xs text-[var(--ink-muted)]">
            {reason ? `原因：${reason}` : '原因：未知'}
            {takeover.message ? ` · ${takeover.message}` : ''}
          </div>
          {takeover.url && <div className="mt-0.5 truncate text-xs text-[var(--ink-subtle)]">{takeover.url}</div>}
        </div>
      </div>
      {error && <div role="alert" className="mt-2 text-xs text-[var(--error)]">{error}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {takeover.url && <Button onClick={() => openWebLink(takeover.url!)}>查看现场</Button>}
        {takeover.state === 'paused' && (
          <Button variant="primary" busy={busy === 'take'} disabled={busy !== null} onClick={() => void act('take')}>接管</Button>
        )}
        {(takeover.state === 'human_active' || takeover.state === 'paused') && (
          <Button busy={busy === 'handback'} disabled={busy !== null} onClick={() => void act('handback')}>交回</Button>
        )}
      </div>
    </div>
  );
}

export function CareerProgressRow({ progress, onDismiss }: { progress: CareerProgressEvent; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  const pct = typeof progress.progress === 'number' ? Math.round(Math.max(0, Math.min(1, progress.progress)) * 100) : null;
  return (
    <div data-testid="career-progress-row" className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <button type="button" onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
        <span className="shrink-0 font-medium text-[var(--ink)]">{progress.phase}</span>
        <span className="min-w-0 flex-1 truncate">{progress.message}</span>
        {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </button>
      {open && (
        <div className="mt-1.5 flex items-center gap-3 pl-5 text-xs text-[var(--ink-subtle)]">
          {progress.taskId && <span>任务 {progress.taskId}</span>}
          {progress.runId && <span>运行 {progress.runId}</span>}
          {pct !== null && (
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--line-subtle)]">
              <span className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
            </span>
          )}
          {onDismiss && <button type="button" onClick={onDismiss} className="underline underline-offset-2">隐藏</button>}
        </div>
      )}
    </div>
  );
}
