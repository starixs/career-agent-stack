/**
 * 对话内求职卡片：待审核动作 / 浏览器需要你 / 可折叠进度行。
 * 状态来自 TabContext（TabProvider 处理 career:* SSE），回传走 Session 路由。
 * 在 TabProvider 之外渲染时返回 null，MessageList 的既有测试不受影响。
 */
import { ChevronDown, ChevronRight, Globe, ListChecks, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useTabStateOptional } from '@/context/TabContext';

import { BrowserWorkCard, shouldShowBrowserCard } from './BrowserWorkCard';
import { CareerFlowCards, useBatchState } from './CareerFlowCards';
import { CareerKeysPanel, useCareerSetupStatus } from './CareerKeysPanel';
import { openLiveDrawer } from './CareerLiveDrawer';

import { ACTION_KIND_LABELS, HANDOFF_REASON_LABELS, TAKEOVER_STATE_LABELS } from './careerConstants';
import { Badge, Button } from './CareerPrimitives';
import type { ActionKind, CareerProgressEvent, CareerReviewEvent, CareerTakeoverEvent } from './types';

export function CareerChatCards() {
  const tab = useTabStateOptional();
  if (!tab) return null;
  return <CareerChatCardsInner tab={tab} />;
}

function CareerChatCardsInner({ tab }: { tab: NonNullable<ReturnType<typeof useTabStateOptional>> }) {
  const batch = useBatchState();
  const { pendingCareerReview, careerTakeover, careerProgress } = tab;
  // 底部只放"无处可挂"的待处理卡片：没有锚点（后台批量等），或锚点那次工具调用不在已加载的消息里。
  // 有锚点的卡片渲染在对应回复下面（Message.tsx），处理完折叠，不在底部堆叠。
  const anchoredIds = useMemo(() => collectToolUseIds(tab.messages ?? []), [tab.messages]);
  const cards = useMemo(() => (tab.careerCards ?? []).filter(c => (c.state ?? 'pending') === 'pending' && (!c.toolUseId || !anchoredIds.has(c.toolUseId))), [tab.careerCards, anchoredIds]);
  return (
    <div className="space-y-2 py-2">
      <CareerSetupCards />
      {careerProgress && <CareerProgressRow progress={careerProgress} onDismiss={tab.dismissCareerProgress} />}
      {shouldShowBrowserCard(careerTakeover, careerProgress, batch) && (
        <BrowserWorkCard takeover={careerTakeover} progress={careerProgress} />
      )}
      <CareerFlowCards cards={cards} batch={batch} onStateChange={(id, state) => tab.setCareerCardState?.(id, state)} />
      {pendingCareerReview && <CareerReviewCard review={pendingCareerReview} onDecision={tab.respondCareerReview} />}
    </div>
  );
}

const SEARCH_SETUP_DISMISSED_KEY = 'career.searchSetupDismissed';
function readDismissed(): boolean { try { return window.localStorage.getItem(SEARCH_SETUP_DISMISSED_KEY) === '1'; } catch { return false; } }

/**
 * 依赖配置卡：没有模型 Key 时助理根本跑不起来，固定在对话底部直到配好（必需）；
 * 搜索 Key 没配时给一张可"暂不配置"的建议卡（记住选择，不再打扰）。
 */
export function CareerSetupCards() {
  const { status } = useCareerSetupStatus();
  const [searchDismissed, setSearchDismissed] = useState(readDismissed);
  if (!status) return null;
  const needLlm = !status.llm.configured;
  const suggestSearch = !status.search.configured && !searchDismissed;
  if (!needLlm && !suggestSearch) return null;
  const dismissSearch = () => { try { window.localStorage.setItem(SEARCH_SETUP_DISMISSED_KEY, '1'); } catch { /* 隐私模式 */ } setSearchDismissed(true); };
  return (
    <div data-testid="career-setup-cards" className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-[var(--ink)]">{needLlm ? '先配置模型 Key，助理才能开始工作' : '建议配置搜索 Key'}</span>
        {needLlm ? <Badge tone="warning">必需</Badge> : <Badge tone="info">建议</Badge>}
        {!needLlm && <Button variant="ghost" className="ml-auto" onClick={dismissSearch}>暂不配置</Button>}
      </div>
      <div className="mt-3"><CareerKeysPanel show={needLlm ? (suggestSearch ? 'all' : 'llm') : 'search'} /></div>
    </div>
  );
}

/** 已加载消息里所有顶层工具调用的 id（卡片锚点）。 */
export function collectToolUseIds(messages: ReadonlyArray<{ content: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; tool?: { id?: string } }>) {
      if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.tool?.id) ids.add(b.tool.id);
    }
  }
  return ids;
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
    <div data-testid="career-review-card" className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10">
          <ListChecks className="size-4 text-[var(--primary)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="accent">待审核</Badge>
            <Badge>{kindLabel}</Badge>
            <span className="text-xs text-[var(--muted)]">{review.actionIds.length} 个动作</span>
          </div>
          <div className="mt-1 text-sm text-[var(--ink)]">{review.summary}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-[var(--muted)]">提交与发送永远需要你批准后才会执行。</div>
      {error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</div>}
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
  const [busy, setBusy] = useState<'take' | 'handback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'take' | 'handback') => {
    setBusy(action);
    setError(null);
    const ok = await onAction(takeover.runId, action);
    if (!ok) setError('操作失败，请重试');
    // 接管后直接在聊天旁的画面里操作，不切窗口、不跳页
    else if (action === 'take') openLiveDrawer();
    setBusy(null);
  };
  const reason = takeover.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;
  const stateLabel = TAKEOVER_STATE_LABELS[takeover.state] ?? takeover.state;
  const tone = takeover.state === 'paused' ? 'warning' : takeover.state === 'human_active' ? 'info' : 'neutral';
  return (
    <div data-testid="career-takeover-card" className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--warning-bg)]">
          <Globe className="size-4 text-[var(--warning)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">浏览器需要你</span>
            <Badge tone={tone}>{stateLabel}</Badge>
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {reason ? `原因：${reason}` : '原因：未知'}
            {takeover.message ? ` · ${takeover.message}` : ''}
          </div>
          {takeover.url && <div className="mt-0.5 truncate text-xs text-[var(--subtle)]">{takeover.url}</div>}
        </div>
      </div>
      {error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => openLiveDrawer()}>在旁边打开现场</Button>
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
    <div data-testid="career-progress-row" className="rounded-lg border border-[var(--line)] bg-[var(--inset)] px-3 py-1.5 text-xs text-[var(--muted)]">
      <button type="button" onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--primary)]" />
        <span className="shrink-0 font-medium text-[var(--ink)]">{progress.phase}</span>
        <span className="min-w-0 flex-1 truncate">{progress.message}</span>
        {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
      </button>
      {open && (
        <div className="mt-1.5 flex items-center gap-3 pl-5 text-xs text-[var(--subtle)]">
          {progress.taskId && <span>任务 {progress.taskId}</span>}
          {progress.runId && <span>运行 {progress.runId}</span>}
          {pct !== null && (
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--line)]">
              <span className="block h-full bg-[var(--primary)]" style={{ width: `${pct}%` }} />
            </span>
          )}
          {onDismiss && <button type="button" onClick={onDismiss} className="underline underline-offset-2">隐藏</button>}
        </div>
      )}
    </div>
  );
}
