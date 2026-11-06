/**
 * 发邮件前过目的落库：发出 = 批准这几封的 send_mail（服务端立即发）；不投这家 = 拒绝并把申请标成跳过；
 * 不跟了 / 我自己回 = 拒绝（申请不动）。都走 /api/career/actions/review，和网申投前过目同一条路。
 *
 * 发信只在卡组里、看过整封预览之后（2026-11-05 用户：发前要预览确认）：卡组外的入口（建议条、下一步条、
 * 邮件往来里那封待发的）一律只打开卡组定位到它，这里没有「不看就发」的函数。
 */
import type { MailDraftView, MailPurpose } from '../../../../shared/careerMailApply';
import { careerApi } from '../careerApi';
import { deliveryApi, localMidnightIso, type AskView } from '../delivery/deliveryApi';
import { requestOpenDeck } from '../delivery/openDeck';
import type { AskOutcome, Respond } from '../delivery/useAskActions';

/** 这一下能发出的：勾了、而且不差东西。 */
export function sendableIds(drafts: readonly MailDraftView[], picked: ReadonlySet<string>): string[] {
  return drafts.filter(d => picked.has(d.action_id) && d.blockers.length === 0).map(d => d.action_id);
}

/** 还没连邮箱：主按钮先变「连邮箱」。 */
export const needsMailbox = (drafts: readonly MailDraftView[]): boolean => drafts.some(d => d.blockers.includes('no_mailbox'));

/** 发出这几封；发完了剩下的还有就留着这件事（'kept'），全发完才算办掉。只由卡组里的邮件卡调用。 */
export async function sendMails(respond: Respond, ids: readonly string[], remaining: number): Promise<AskOutcome> {
  if (!ids.length) return 'kept';
  if (!(await respond([...ids], 'approved'))) throw new Error('没能发出去，请重试');
  return ids.length >= remaining ? 'resolved' : 'kept';
}

/** 副按钮：投递邮件「不投这家」带 drop（申请标成跳过）；跟进、回信只是不发这封。 */
export async function declineMails(purpose: MailPurpose, respond: Respond, ids: readonly string[]): Promise<AskOutcome> {
  if (purpose === 'apply') await careerApi.reviewActions([...ids], 'rejected', { drop: true });
  else if (!(await respond([...ids], 'rejected'))) throw new Error('没能保存你的决定，请重试');
  return 'resolved';
}

/** 几封里只拒绝这一封（跟进「这家不跟了」，不 drop）：还剩别的就留着这件事。 */
export async function declineOne(respond: Respond, id: string, remaining: number): Promise<AskOutcome> {
  if (!(await respond([id], 'rejected'))) throw new Error('没能保存你的决定，请重试');
  return remaining > 1 ? 'kept' : 'resolved';
}

/** 打开卡组定位到含这几封邮件的那件；还没派生出来（找不到）就从最急的开始。 */
export async function openDeckForMail(actionIds: readonly string[]): Promise<void> {
  const { asks } = await deliveryApi.asks(localMidnightIso());
  const hit = asks.find(a => a.mail?.action_ids.some(id => actionIds.includes(id)));
  requestOpenDeck(hit ? hit.id : null);
}

/** 失败那件涉及的邮件动作 id（服务端放在 action_ids 或 sources 里）。 */
function failedMailIds(ask: AskView): string[] {
  const fromSources = ask.sources.filter(s => s.type === 'action').map(s => s.id);
  return [...new Set([...(ask.action_ids ?? []), ...fromSources])];
}

/**
 * 「再写一次」「再发一次」（以及连上邮箱之后）：整件放回队列。
 * 没发出去的放回待发后会重新出现成「邮件写好了」，卡组先拿走这件，再定位过去让他看着点发出——发送永远过人。
 */
export async function retryMailFailed(ask: AskView): Promise<AskOutcome> {
  await deliveryApi.retryFailed(ask.id);
  if (ask.mail_failed?.stage === 'send') {
    const ids = failedMailIds(ask);
    // 等卡组先按 'resolved' 拿走这件（同一轮里），再翻到重新出现的那件
    window.setTimeout(() => {
      openDeckForMail(ids).catch((e: unknown) => {
        console.error('[career] mail-apply reopen deck FAILED ask=', ask.id, e instanceof Error ? e.message : String(e));
        requestOpenDeck(null);
      });
    }, 0);
  }
  return 'resolved';
}
