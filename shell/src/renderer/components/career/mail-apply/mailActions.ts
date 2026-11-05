/**
 * 发邮件前过目的落库：发出 = 批准这几封的 send_mail（服务端立即发）；不投这家 = 拒绝并把申请标成跳过；
 * 不跟了 / 我自己回 = 拒绝（申请不动）。都走 /api/career/actions/review，和网申投前过目同一条路。
 */
import type { MailDraftView } from '../../../../shared/careerMailApply';
import { careerApi } from '../careerApi';
import type { AskView } from '../delivery/deliveryApi';
import type { AskOutcome, Respond } from '../delivery/useAskActions';
import { mailApplyApi } from './mailApplyApi';

/** 这一下能发出的：勾了、而且不差东西。 */
export function sendableIds(drafts: readonly MailDraftView[], picked: ReadonlySet<string>): string[] {
  return drafts.filter(d => picked.has(d.action_id) && d.blockers.length === 0).map(d => d.action_id);
}

/** 还没连邮箱：主按钮先变「连邮箱」。 */
export const needsMailbox = (drafts: readonly MailDraftView[]): boolean => drafts.some(d => d.blockers.includes('no_mailbox'));

/** 发出这几封；发完了剩下的还有就留着这件事（'kept'），全发完才算办掉。 */
export async function sendMails(respond: Respond, ids: readonly string[], remaining: number): Promise<AskOutcome> {
  if (!ids.length) return 'kept';
  if (!(await respond([...ids], 'approved'))) throw new Error('没能发出去，请重试');
  return ids.length >= remaining ? 'resolved' : 'kept';
}

/** 副按钮：投递邮件「不投这家」带 drop（申请标成跳过）；跟进、回信只是不发这封。 */
export async function declineMails(ask: AskView, respond: Respond, ids: readonly string[]): Promise<AskOutcome> {
  if (ask.mail?.purpose === 'apply') await careerApi.reviewActions([...ids], 'rejected', { drop: true });
  else if (!(await respond([...ids], 'rejected'))) throw new Error('没能保存你的决定，请重试');
  return 'resolved';
}

/** 卡组外（建议条「都发出」）：取这几封的预览，发出不差东西的；有差东西的留着，由调用方打开卡组。 */
export async function sendReadyMails(ask: AskView, respond: Respond): Promise<AskOutcome> {
  const ids = ask.mail?.action_ids ?? [];
  const drafts = await mailApplyApi.drafts(ids);
  if (!drafts.length) return 'resolved'; // 都已经处理掉了
  const ready = sendableIds(drafts, new Set(ids));
  return sendMails(respond, ready, drafts.length);
}
