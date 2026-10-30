/**
 * 卡组里两个按钮真正做的事。每件事按它的源落库（截止 → 截止接口；待批准 → 审批；登录 → 登录之旅；确认 → 打开旁边的浏览器现场）；
 * 缺信息走 /asks/:id/fill，填一次整批由后台接着填，不经过对话。落库成功的事返回 'resolved'（卡组把它拿走，服务端下次派生也不会再有）；只是挪后的返回 'snoozed'。
 */
import { useState } from 'react';

import { openExternal } from '@/utils/openExternal';

import { careerApi } from '../careerApi';
import { openLiveDrawer } from '../CareerLiveDrawer';
import { suggestToChat } from '../CareerPrimitives';
import { reviewDecisionMessage, useRespondReview } from '../CareerReviewCard';
import { deliveryApi, type AskView } from './deliveryApi';

export type AskOutcome = 'resolved' | 'snoozed' | 'kept';
type Respond = ReturnType<typeof useRespondReview>;

const sourceIds = (ask: AskView, type: AskView['sources'][number]['type']) => ask.sources.filter(s => s.type === type).map(s => s.id);
const firstDeadline = (ask: AskView) => sourceIds(ask, 'deadline')[0];

async function decideReview(respond: Respond, ask: AskView, decision: 'approved'): Promise<AskOutcome> {
  const ids = sourceIds(ask, 'action');
  if (!(await respond(ids, decision))) throw new Error('没能保存你的决定，请重试');
  const msg = reviewDecisionMessage({ actionIds: ids, kind: ask.kind === 'start' ? 'fill_form' : 'submit', summary: ask.title }, decision);
  suggestToChat(msg.text, msg.context);
  return 'resolved';
}

/**
 * 缺信息：填一次，挡住的那一批全部放行（一事多申）。服务端存进本机私密库 / 答案库（明文不经过模型），
 * 关掉这批接管、交给后台从各自的当前页接着填——不发话给助理，也不要你再点。
 */
async function fillFields(ask: AskView, values: Record<string, string>): Promise<AskOutcome> {
  const { stillWaiting } = await deliveryApi.fill(ask.id, values);
  return stillWaiting > 0 ? 'kept' : 'resolved';
}

async function goDeadline(ask: AskView): Promise<AskOutcome> {
  if (ask.deadline_kind === 'interview') suggestToChat(`帮我准备${ask.title}`, { surface: 'interview', refs: { application_id: ask.application_ids[0] } });
  else if (ask.url) await openExternal(ask.url);
  else suggestToChat(`${ask.title}在哪做？帮我找一下入口`, { surface: 'today', refs: { deadline_id: firstDeadline(ask) } });
  return 'kept';
}

async function go(ask: AskView, respond: Respond, values: Record<string, string>): Promise<AskOutcome> {
  switch (ask.kind) {
    case 'start': case 'review': return decideReview(respond, ask, 'approved');
    case 'info': return fillFields(ask, values);
    // 登录之旅：服务端把画面钉在第一家，登上了（数据层判断）或你点交还就切下一家
    case 'login': await deliveryApi.loginJourney(ask.id); openLiveDrawer(); return 'kept';
    case 'confirm': openLiveDrawer(); return 'kept';
    case 'attendance': await careerApi.answerAttendance(firstDeadline(ask), true); return 'resolved';
    case 'retro': suggestToChat(ask.suggest ?? `复盘一下${ask.title}`); return 'kept';
    default: return goDeadline(ask);
  }
}

async function later(ask: AskView): Promise<AskOutcome> {
  switch (ask.kind) {
    case 'attendance': await careerApi.answerAttendance(firstDeadline(ask), false); return 'resolved';
    case 'retro': await careerApi.setDeadlineStatus(firstDeadline(ask), 'done'); return 'resolved';
    case 'review': suggestToChat(`${ask.title.split(' · ')[0]}这份我要改一下：`, { surface: 'apply', refs: { action_id: sourceIds(ask, 'action').join(',') } }, 'prefill'); return 'kept';
    case 'deadline':
      if (ask.deadline_kind === 'interview' || !firstDeadline(ask)) return 'snoozed';
      await careerApi.setDeadlineStatus(firstDeadline(ask), 'done'); return 'resolved';
    case 'login': await deliveryApi.loginJourney(ask.id, true); return 'snoozed';
    default: return 'snoozed';
  }
}

export function useAskActions() {
  const respond = useRespondReview();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<AskOutcome>): Promise<AskOutcome | null> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[career] ask action FAILED', message);
      setError(message);
      return null;
    } finally { setBusy(false); }
  };
  return {
    busy, error,
    go: (ask: AskView, values: Record<string, string> = {}) => run(() => go(ask, respond, values)),
    later: (ask: AskView) => run(() => later(ask)),
  };
}
