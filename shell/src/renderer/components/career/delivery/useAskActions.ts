/**
 * 卡组里两个按钮真正做的事。不另造接口：每件事按它的源落库（截止 → 截止接口；待批准 → 审批；
 * 缺信息 → 私密库 / 答案库后让助理接着填；登录 / 确认 → 打开旁边的浏览器现场）。
 * 落库成功的事返回 'resolved'（卡组把它拿走，服务端下次派生也不会再有）；只是挪后的返回 'snoozed'。
 */
import { useState } from 'react';

import { openExternal } from '@/utils/openExternal';

import { careerApi } from '../careerApi';
import { openLiveDrawer } from '../CareerLiveDrawer';
import { suggestToChat } from '../CareerPrimitives';
import { reviewDecisionMessage, useRespondReview } from '../CareerReviewCard';
import type { AskView } from './deliveryApi';

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

/** 缺信息：资料类写私密库（明文不经过模型），其余写答案库；然后让助理把停下的那几份从当前页接着填。 */
async function fillFields(ask: AskView, values: Record<string, string>): Promise<AskOutcome> {
  const filled = (ask.fields ?? []).filter(f => f.fillable && values[f.label]?.trim());
  for (const f of filled) {
    const value = values[f.label].trim();
    if (f.vault_field) await careerApi.vaultSet({ scope: 'profile', field: f.vault_field, value });
    else await careerApi.saveAnswer({ question_key: f.label, question_text: f.label, answer: value, confirmed: true });
  }
  const actions = ask.action_ids ?? [];
  suggestToChat(`${filled.map(f => f.label).join('、')}填好了，${actions.length} 家接着填吧。`, {
    surface: 'apply', refs: { action_id: actions.join(',') },
    note: '缺项已补进私密库 / 答案库：对 action_id 里的每一份依次调用 apply_continue(action_id) 从当前页继续并重新检查。',
  });
  return 'resolved';
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
    case 'login': case 'confirm': openLiveDrawer(); return 'kept';
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
