/**
 * 起草器写好一封投递邮件之后：他放权了（总开关 / 「邮件投递」这一类盖过章）、而且这封不差东西，就直接发出（第三轮 R2）。
 * 先落 approved（批准人是 auto / delegated，动作上看得出谁批的），再交给 sendNow（Global 里就是 executeSendMailAction）；
 * 发送失败照常进「没发出去」。不放的留在待审给他看（现状）。没有 sendNow（不在 Global）一律不直接发。
 */
import type { ActionQueueItem } from '@career/core';

import type { DrafterDeps } from './draft-common';
import { resolveMail } from './resolve';
import { decideMailSend } from './send-policy';

export type AutoSendOutcome = 'held' | 'sent' | 'failed';

export async function maybeSendNow(deps: DrafterDeps, send: ActionQueueItem): Promise<AutoSendOutcome> {
  if (!deps.sendNow) return 'held';
  const mail = resolveMail({ repos: deps.repos, vault: deps.vault }, send);
  const decision = decideMailSend(deps.repos, { action: send, blockers: mail.blockers, applicationId: send.application_id });
  if (!decision.approve) return 'held';
  if (!deps.repos.reviewActions([send.id], 'approved', decision.by)) return 'held';
  console.log(`[career] mail-send auto action=${send.id} by=${decision.by}`);
  try {
    await deps.sendNow(send.id);
    return 'sent';
  } catch (error) {
    console.warn(`[career] mail-send auto FAILED action=${send.id} detail=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return 'failed';
  }
}
