/**
 * 卡组里两个按钮真正做的事。每件事按它的源落库（截止 → 截止接口；待批准 → 审批，后台接着填 / 提交；登录 → 登录之旅；投出了吗 → 确认结果）；
 * 缺信息走 /asks/:id/fill，填一次整批由后台接着填，不经过对话。落库成功的事返回 'resolved'（卡组把它拿走，服务端下次派生也不会再有）；只是挪后的返回 'snoozed'。
 */
import { useState } from 'react';

import { openExternal } from '@/utils/openExternal';

import { careerApi } from '../careerApi';
import { openLiveDrawer } from '../CareerLiveDrawer';
import { suggestToChat } from '../CareerPrimitives';
import { useRespondReview } from '../CareerReviewCard';
import { deliveryApi, type AskView } from './deliveryApi';
import { holdSubmit, type HoldChoice } from './holdSubmit';

export type AskOutcome = 'resolved' | 'snoozed' | 'kept';
type Respond = ReturnType<typeof useRespondReview>;

const sourceIds = (ask: AskView, type: AskView['sources'][number]['type']) => ask.sources.filter(s => s.type === type).map(s => s.id);
const firstDeadline = (ask: AskView) => sourceIds(ask, 'deadline')[0];

/** 「都开始投」「一键投出」「就这样投出」：落审批即可，填表 / 提交由后台接手，不发话给助理。 */
async function decideReview(respond: Respond, ask: AskView): Promise<AskOutcome> {
  if (!(await respond(sourceIds(ask, 'action'), 'approved'))) throw new Error('没能保存你的决定，请重试');
  return 'resolved';
}

/** 「投出了吗」：看过页面后一键回答，不用在对话里说。没投出去的回到待审，重新出现在等你条里。 */
async function confirmSent(ask: AskView, submitted: boolean): Promise<AskOutcome> {
  const id = ask.action_ids?.[0];
  if (!id) throw new Error('找不到这份投递的提交记录');
  await careerApi.confirmSubmit(id, submitted);
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
    case 'start': case 'review': return decideReview(respond, ask);
    case 'info': return fillFields(ask, values);
    // 登录之旅：服务端把画面钉在第一家，登上了（数据层判断）或你点交还就切下一家
    case 'login': await deliveryApi.loginJourney(ask.id); openLiveDrawer(); return 'kept';
    case 'confirm': return confirmSent(ask, true);
    case 'attendance': await careerApi.answerAttendance(firstDeadline(ask), true); return 'resolved';
    case 'retro': suggestToChat(ask.suggest ?? `复盘一下${ask.title}`); return 'kept';
    default: return goDeadline(ask);
  }
}

async function later(ask: AskView): Promise<AskOutcome> {
  switch (ask.kind) {
    case 'attendance': await careerApi.answerAttendance(firstDeadline(ask), false); return 'resolved';
    case 'retro': await careerApi.setDeadlineStatus(firstDeadline(ask), 'done'); return 'resolved';
    case 'deadline':
      if (ask.deadline_kind === 'interview' || !firstDeadline(ask)) return 'snoozed';
      await careerApi.setDeadlineStatus(firstDeadline(ask), 'done'); return 'resolved';
    case 'login': await deliveryApi.loginJourney(ask.id, true); return 'snoozed';
    case 'confirm': return confirmSent(ask, false);
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
    hold: (ask: AskView, choice: HoldChoice) => run(() => holdSubmit(sourceIds(ask, 'action'), choice)),
  };
}
