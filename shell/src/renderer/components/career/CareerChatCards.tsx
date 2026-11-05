/**
 * 对话内求职卡片（对话底部）：开场（小芽先开口，排在最前）/ 没有锚点的流程卡片 / 回来卡（离开超过半天）。
 * 进度不在对话里出行，只在右栏「正在做」（内测收口 11-05）。
 * 浏览器现场与它的交接不在对话里出卡，在右栏「网申」那一行（主线体验 §6.6 三选一）。
 * 要你的事（待审核、缺项）不在这里，在输入框上沿的等你条。
 * 状态来自 TabContext（TabProvider 处理 career:* SSE），回传走 Session 路由。
 * 待审核动作是 kind=review 的流程卡片（CareerReviewCard.tsx），有锚点时挂在那次工具调用下面。
 * 在 TabProvider 之外渲染时返回 null，MessageList 的既有测试不受影响。
 */
import { Globe } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useTabStateOptional } from '@/context/TabContext';


import { CareerFlowCards } from './CareerFlowCards';
import { ReturnBriefing } from './delivery/ReturnCard';
import { StarterCard } from './ColdStartCards';
import { openLiveDrawer } from './CareerLiveDrawer';

import { HANDOFF_REASON_LABELS, TAKEOVER_STATE_LABELS } from './careerConstants';
import { Badge, Button } from './CareerPrimitives';
import type { CareerTakeoverEvent } from './types';

export { reviewDecisionMessage } from './CareerReviewCard';

export function CareerChatCards() {
  const tab = useTabStateOptional();
  if (!tab) return null;
  return <CareerChatCardsInner tab={tab} />;
}

function CareerChatCardsInner({ tab }: { tab: NonNullable<ReturnType<typeof useTabStateOptional>> }) {
  // 底部只放"无处可挂"的待处理卡片：没有锚点（后台批量等），或锚点那次工具调用不在已加载的消息里。
  // 有锚点的卡片渲染在对应回复下面（Message.tsx），处理完折叠，不在底部堆叠。
  const anchoredIds = useMemo(() => collectToolUseIds(tab.messages ?? []), [tab.messages]);
  const cards = useMemo(() => (tab.careerCards ?? []).filter(c => (c.state ?? 'pending') === 'pending' && (!c.toolUseId || !anchoredIds.has(c.toolUseId))), [tab.careerCards, anchoredIds]);
  const conversationStarted = useMemo(() => (tab.messages ?? []).some(m => m.role === 'user'), [tab.messages]);
  return (
    <div className="space-y-2 py-2">
      <StarterCard conversationStarted={conversationStarted} />
      <CareerFlowCards cards={cards} onStateChange={(id, state) => tab.setCareerCardState?.(id, state)} />
      <ReturnBriefing messageCount={tab.messages?.length ?? 0} />
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
            {[reason, takeover.message].filter(Boolean).join(' · ')}
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
