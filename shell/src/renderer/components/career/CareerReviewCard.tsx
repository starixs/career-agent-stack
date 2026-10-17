/**
 * 对话内审核卡片（kind=review）与"还差几项要你补"的交接卡（kind=apply_gaps）。
 *
 * 审核卡片：每个待批准动作一张（id 见 shared/careerReviewCard.ts），和其他流程卡片一样按 toolUseId
 * 挂在产生它的工具调用下面，刷新后从库里读回；Global 后台（批量 / 提交执行器）推来的 `career:review`
 * 事件由 upsertReviewCard 合并成同 id 的卡片（没有锚点时放在对话底部）。提交卡里嵌审阅清单。
 *
 * 发回对话的话只写人话；要调哪个工具、哪个动作放在隐藏上下文（refs / note）里给助理。
 */
import { ClipboardList, ListChecks } from 'lucide-react';
import { useState } from 'react';

import { useCareerCards } from '@/context/CareerCardsContext';
import { useTabStateOptional } from '@/context/TabContext';

import { reviewCardId, REVIEW_CARD_KIND } from '../../../shared/careerReviewCard';

import { careerApi } from './careerApi';
import { ACTION_KIND_LABELS } from './careerConstants';
import { openLiveDrawer } from './CareerLiveDrawer';
import { Badge, Button, suggestToChat, type ChatContext } from './CareerPrimitives';
import { SubmitReviewList } from './SubmitReviewList';
import type { ActionKind, CareerCard, CareerReviewEvent, SubmitReviewSummary } from './types';

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `career:review` 事件 → 同 id 的审核卡片：已有的保留锚点与已展示的内容（如审阅清单），状态回到待处理。 */
export function upsertReviewCard(prev: CareerCard[], ev: CareerReviewEvent): CareerCard[] {
  if (!Array.isArray(ev.actionIds) || ev.actionIds.length === 0) return prev;
  const id = reviewCardId(ev.actionIds);
  const old = prev.find(c => c.id === id);
  const next: CareerCard = {
    id, kind: REVIEW_CARD_KIND, title: ev.summary,
    data: { ...(old?.data ?? {}), ...(ev.data ?? {}), action_ids: ev.actionIds, kind: ev.kind, summary: ev.summary },
    createdAt: old?.createdAt ?? new Date().toISOString(), sessionId: ev.sessionId ?? old?.sessionId ?? null,
    toolUseId: ev.toolUseId ?? old?.toolUseId ?? null, state: 'pending',
  };
  return [...prev.filter(c => c.id !== id), next];
}

/** 卡片上做了决定后发给助理的话：看得见的是人话，动作 id 和该调的工具放在隐藏上下文里。 */
export function reviewDecisionMessage(review: Pick<CareerReviewEvent, 'actionIds' | 'kind' | 'summary'>, decision: 'approved' | 'rejected'): { text: string; context: ChatContext } {
  const refs = { action_id: review.actionIds.join(',') };
  if (decision === 'rejected') {
    return { text: `这一步先不做了：${review.summary}。先别执行，问问我接下来怎么办。`, context: { surface: 'apply', refs, note: '用户在卡片上拒绝了这些动作（已作废）。不要执行，问用户下一步。' } };
  }
  if (review.kind === 'fill_form') {
    return { text: `可以开始填了：${review.summary}。填的时候告诉我进展。`, context: { surface: 'apply', refs, note: '用户在卡片上同意开始填写：对 action_id 里的每一份依次调用 apply_run(action_id)。' } };
  }
  if (review.kind === 'submit') {
    return { text: `我批准提交了：${review.summary}。请跟进提交结果并告诉我。`, context: { surface: 'apply', refs, note: '用户批准了提交，产品会在几秒内替用户点提交；跟进这份投递的提交结果后告诉用户。' } };
  }
  return { text: `我批准了：${review.summary}。请继续，并告诉我结果。`, context: { surface: 'apply', refs } };
}

interface CardProps { card: CareerCard; onDone: () => void; onDismiss: () => void }

/** 批准 / 拒绝：优先走本会话的 Session 路由；不在对话里（没有 TabProvider）时退回 Global 路由。 */
function useRespondReview(): (ids: string[], decision: 'approved' | 'rejected') => Promise<boolean> {
  const cards = useCareerCards();
  const tab = useTabStateOptional();
  return cards.respondReview ?? tab?.respondCareerReview ?? (async (ids, decision) => {
    try { await careerApi.reviewActions(ids, decision); return true; } catch { return false; }
  });
}

export function ReviewCard({ card, onDone }: CardProps) {
  const respond = useRespondReview();
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionIds = strList(card.data.action_ids);
  const kind = str(card.data.kind) ?? '';
  const isSubmit = kind === 'submit';
  const review = (card.data.review ?? null) as SubmitReviewSummary | null;
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!actionIds.length) return;
    setBusy(decision); setError(null);
    const ok = await respond(actionIds, decision);
    setBusy(null);
    if (!ok) { setError('没能保存你的决定，请重试'); return; }
    onDone();
    // 交接：卡片上的决定要让助理知道，它才会接着执行或跟进结果，而不是停在上一轮
    const msg = reviewDecisionMessage({ actionIds, kind, summary: str(card.data.summary) ?? card.title }, decision);
    suggestToChat(msg.text, msg.context);
  };
  const kindLabel = ACTION_KIND_LABELS[kind as ActionKind] ?? '这一步';
  return (
    <div data-testid="career-review-card" className="rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] p-4 shadow-hard-lg">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10">
          <ListChecks className="size-4 text-[var(--primary)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="accent">等你批准</Badge>
            <Badge>{kindLabel}</Badge>
            {actionIds.length > 1 && <span className="text-xs text-[var(--muted)]">{actionIds.length} 份</span>}
          </div>
          <div className="mt-1 text-sm text-[var(--ink)]">{card.title}</div>
        </div>
      </div>
      {isSubmit && <SubmitReviewList review={review} />}
      <div className="mt-3 text-xs text-[var(--muted)]">{str(card.data.note) ?? (isSubmit ? '批准后产品替你点提交；没批准之前不会提交。' : '提交与发送都要你批准后才会执行。')}</div>
      {error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy === 'approved'} disabled={busy !== null} onClick={() => void decide('approved')}>{isSubmit ? '批准提交' : kind === 'fill_form' ? '开始填写' : '批准'}</Button>
        <Button variant="danger" busy={busy === 'rejected'} disabled={busy !== null} onClick={() => void decide('rejected')}>{isSubmit ? '先不提交' : '不要了'}</Button>
        {isSubmit && <Button variant="ghost" disabled={busy !== null} onClick={() => openLiveDrawer()}>在旁边看页面</Button>}
      </div>
    </div>
  );
}

const GAP_LABELS: Record<string, { label: string; tone: 'error' | 'warning' }> = {
  empty: { label: '必填为空', tone: 'error' }, mismatch: { label: '没生效', tone: 'error' }, site_error: { label: '网站提示', tone: 'error' },
  needs_user: { label: '需要你填', tone: 'warning' }, draft: { label: '草稿待确认', tone: 'warning' }, upload_unconfirmed: { label: '附件待确认', tone: 'warning' },
  unverified: { label: '没核对上', tone: 'warning' },
};

/** 停在提交前但还差几项：逐项列字段名和原因；用户补好后让助理从当前页继续检查（提交卡要等检查通过才出现）。 */
export function ApplyGapsCard({ card, onDone, onDismiss }: CardProps) {
  const actionId = str(card.data.action_id);
  const items = (Array.isArray(card.data.items) ? card.data.items : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map(i => ({ label: str(i.label) ?? '', reason: str(i.reason), status: str(i.status) ?? '' }))
    .filter(i => i.label);
  const filled = typeof card.data.required_filled === 'number' ? card.data.required_filled : null;
  const total = typeof card.data.required_total === 'number' ? card.data.required_total : null;
  const resume = () => {
    onDone();
    suggestToChat('缺的几项我补好了，请从当前页接着检查。', { surface: 'apply', refs: actionId ? { action_id: actionId } : {}, note: '用户说缺项已补好：调用 apply_continue(action_id) 从当前页继续填写并重新检查。' });
  };
  return (
    <div data-testid="career-card-apply_gaps" className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--warning-bg)] text-[var(--warning)]"><ClipboardList className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">{card.title}</span>
            {total !== null && total > 0 && <Badge tone="warning">必填 {filled ?? 0}/{total}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-[var(--muted)]">还没提交。补好之后我从当前页接着检查，全部过关才会请你批准提交。</div>
        </div>
        <Button variant="ghost" onClick={onDismiss} aria-label="稍后再说">稍后</Button>
      </div>
      <ul className="mt-3 space-y-1 text-xs">
        {items.map((i, idx) => (
          <li key={`${i.label}-${idx}`} className="flex flex-wrap items-baseline gap-1.5">
            <Badge tone={GAP_LABELS[i.status]?.tone ?? 'warning'}>{GAP_LABELS[i.status]?.label ?? '要你看'}</Badge>
            <span className="font-medium text-[var(--ink)]">{i.label}</span>
            {i.reason && <span className="text-[var(--muted)]">— {i.reason}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => openLiveDrawer()}>在旁边打开页面</Button>
        <Button variant="primary" onClick={resume}>补好了，继续检查</Button>
      </div>
    </div>
  );
}
