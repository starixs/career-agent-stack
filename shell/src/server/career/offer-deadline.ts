/**
 * Offer 的答复期限只有一处真相：offer.deadline 是用户 / 来信给的日期，截止事件（deadline 表 offer_reply）
 * 是今日队列、月历、通知读的那一份。任何入口（归档、Offer 页、对话）写 offer.deadline 都经这里同步过去，
 * 否则页面上改了日期、队列还按旧日期催，或者手动录的 Offer 根本进不了队列。
 */
import { CLOSED_STAGES, type Deadline, type Offer, type Repos } from '@career/core';

export function offerReplyTitle(offer: Pick<Offer, 'company_name' | 'title'>): string {
  return `${offer.company_name ?? '未知公司'}${offer.title ? ` · ${offer.title}` : ''} Offer 回复截止`;
}

/**
 * 让这个 Offer 的 offer_reply 截止事件跟 offer.deadline 一致；返回当前那条（没有期限时为 undefined）。
 * 投递已经关掉（接受 / 被拒 / 放弃）= 已答复，不再建回复期限。
 */
export function syncOfferReplyDeadline(repos: Repos, offer: Offer, source = 'offer'): Deadline | undefined {
  const mine = repos.listDeadlines({ status: 'open_or_missed' }).filter(d => d.offer_id === offer.id && d.kind === 'offer_reply');
  const app = offer.application_id ? repos.getApplication(offer.application_id) : undefined;
  const settled = !!app && CLOSED_STAGES.includes(app.stage);
  if (!offer.deadline || settled) {
    for (const d of mine) repos.setDeadlineStatus(d.id, 'cancelled');
    return undefined;
  }
  const [keep, ...extra] = mine;
  for (const d of extra) repos.setDeadlineStatus(d.id, 'cancelled');
  if (!keep) {
    return repos.createDeadline({ kind: 'offer_reply', title: offerReplyTitle(offer), due_at: offer.deadline, application_id: offer.application_id, job_id: app?.job_id ?? null, offer_id: offer.id, source });
  }
  if (keep.due_at === offer.deadline && keep.status === 'open') return keep;
  repos.db.update('deadline', keep.id, { due_at: offer.deadline, status: 'open', updated_at: new Date().toISOString() });
  return repos.getDeadline(keep.id);
}
