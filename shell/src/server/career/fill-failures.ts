/**
 * 填表没成（出错面）：失败后自动再试一次（core fill-retry），再失败成一件「N 家没填成」进等你，卡上两个动作——
 *  - 再试一次：这几份放回队列（retryFailedFill，原批准仍有效），叫醒后台只填这几份；
 *  - 我自己来：给每份开一个 user_request 接管（和「等你过一下」同一种），把现场画面切到那一家；
 *    他在浏览器里弄好点「交还」，后台从当前页接着填、重新检查，和其他接管一样。
 */
import { autoRetryFailedFill, type AskView, type AutoRetryResult, type Repos } from '@career/core';

import { BatchRunner } from './batch-runner';
import { asksFor } from './delivery';
import { kickMailDrafter } from './mail-apply/runner';
import { setViewApp } from './live-pin';

/** 「我自己来」接管上给他看的那句话。 */
const SELF_HANDOFF_MESSAGE = '你在浏览器里把这一家弄好，点「交还」我从当前页接着检查';

export class FailedAskError extends Error {}

/** 对话里跑的填表失败后调用：没试过就放回队列并叫醒后台（批量运行器自己失败的不用叫，循环还在跑）。 */
export function scheduleFillRetry(repos: Repos, actionId: string): AutoRetryResult {
  const result = autoRetryFailedFill(repos, actionId);
  if (result === 'retrying') BatchRunner.command(repos, 'run', 'auto_retry', [actionId]);
  console.log(`[career] fill-retry action=${actionId} result=${result}`);
  return result;
}

function failedAskOf(repos: Repos, askId: string): AskView {
  const ask = asksFor(repos).find(a => a.id === askId && a.kind === 'failed');
  if (!ask) throw new FailedAskError(`这件事已经不在了：${askId}`);
  return ask;
}

/**
 * 一个失败的动作放回去：填表放回队列重填；邮件没写成放回队列重写（kick 起草器）；
 * 邮件没发出去放回待审——发送永远过人，不自动重发，他在「等你」里再点一次发出。
 */
function retryOne(repos: Repos, id: string): 'fill' | 'draft' | 'send' | null {
  const kind = repos.getAction(id)?.kind;
  if (kind === 'draft_mail') return repos.retryFailedDraft(id) ? 'draft' : null;
  if (kind === 'send_mail') return repos.reopenAction(id) ? 'send' : null;
  return repos.retryFailedFill(id) ? 'fill' : null;
}

/** 「再试一次」：这件里的每份都放回去，只重做这几份。返回真放回去的动作 id。 */
export function retryFailedAsk(repos: Repos, askId: string): string[] {
  const ask = failedAskOf(repos, askId);
  const done = (ask.action_ids ?? []).map(id => ({ id, how: retryOne(repos, id) })).filter(x => x.how);
  if (!done.length) throw new FailedAskError('这几份的批准已经失效（材料改过），需要重新开始投');
  const fills = done.filter(x => x.how === 'fill').map(x => x.id);
  if (fills.length) BatchRunner.command(repos, 'run', 'user', fills);
  if (done.some(x => x.how === 'draft')) kickMailDrafter();
  console.log(`[career] failed-ask retry ask=${askId} actions=${done.map(x => `${x.id}:${x.how}`).join(',')}`);
  return done.map(x => x.id);
}

/** 「我自己来」：给这件里的每份（或只给 applicationId 那一份）开接管，现场画面切到第一家。返回开了接管的投递 id。 */
export function takeOverFailedAsk(repos: Repos, askId: string, applicationId?: string): string[] {
  const ask = failedAskOf(repos, askId);
  // 只有网申能「我自己来」（在浏览器里接手）；邮件没写成 / 没发出去的走「再试一次」
  const actions = (ask.action_ids ?? []).map(id => repos.getAction(id)).filter(a => a?.kind === 'fill_form' && !!a.application_id && (!applicationId || a.application_id === applicationId));
  const apps: string[] = [];
  for (const action of actions) {
    if (!action?.application_id) continue;
    repos.openHandoff('user_request', { actionId: action.id, message: SELF_HANDOFF_MESSAGE });
    // blocked 不能直接到 needs_user：沿状态机先回到 pending
    repos.transition(action.application_id, 'pending', '你说自己来');
    repos.transition(action.application_id, 'needs_user', SELF_HANDOFF_MESSAGE, { blocker_reason: `user_request: ${SELF_HANDOFF_MESSAGE}`, next_action: '在浏览器里弄好后交还' });
    apps.push(action.application_id);
  }
  if (!apps.length) throw new FailedAskError(`这件事里没有这一家：${applicationId ?? askId}`);
  setViewApp(apps[0]);
  console.log(`[career] failed-ask self ask=${askId} apps=${apps.join(',')}`);
  return apps;
}
