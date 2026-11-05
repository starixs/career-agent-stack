/**
 * 网申进展页与申请对象卡上的邮件申请：哪些申请走邮件、走到哪一步、对象卡上那条路多出的几节。
 *
 * 数据来源（服务端没有专门字段之前的最小假设，见交付报告）：
 *  - 「这份申请走邮件」：申请列表里 join 的岗位投递邮箱（apply_email），或投递凭据以 `mail:` 开头（已发出的）；
 *  - 「走到哪一步」：这份的邮件往来（/api/career/mail-apply/thread）——有待发的投递邮件 = 等你过目，有发出的 = 已发出。
 */
import type { MailThreadView } from '../../../../shared/careerMailApply';
import type { AskView } from '../delivery/deliveryApi';
import type { Application, ApplicationStage, MailMessage } from '../types';

/** 和申请对象卡那条路的节同形（delivery/applicationTrack.ts TrackNode）：墨色 on、钢笔蓝 ask、其余灰。 */
export interface MailTrackNode { key: string; label: string; date?: string; on?: boolean; ask?: boolean }
type TrackNode = MailTrackNode;

/** 进展页上最多列几份邮件申请（新的在前；再多去卷宗看）。 */
export const MAIL_LIVE_MAX = 30;
const CLOSED = new Set<ApplicationStage>(['discarded', 'skip']);
const SENT = new Set<ApplicationStage>(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);
const MAIL_EVIDENCE = 'mail:';

export function isMailApplication(app: Pick<Application, 'submission_evidence'> & { apply_email?: string | null }): boolean {
  return !!app.apply_email || (app.submission_evidence ?? '').startsWith(MAIL_EVIDENCE);
}

/** 进展页列表：走邮件、没关掉的，最近动过的在前。 */
export function mailApplicationsOf(apps: readonly Application[]): Application[] {
  return apps
    .filter(a => isMailApplication(a) && !CLOSED.has(a.stage))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAIL_LIVE_MAX);
}

/** 已经投出去过（和网申进展页统计同口径）。 */
export const isSentStage = (stage: ApplicationStage): boolean => SENT.has(stage);

/** 等你条上有邮件等他过目（写好了待发 / 回信 / 跟进 / 退回重发）的申请：用同一份要你的事，不逐份去取往来。 */
export function mailWaitingApps(asks: readonly AskView[]): Set<string> {
  return new Set(asks.filter(a => !!a.mail).flatMap(a => a.application_ids));
}

/** 列表上那一行右边的几个字：有邮件等他过目最要紧（钢笔蓝），其余按阶段。 */
export function mailLiveState(stage: ApplicationStage, waiting: boolean): { text: string; ask: boolean } {
  if (waiting) return { text: '等你过目', ask: true };
  return { text: SENT.has(stage) ? '已发出' : '在办', ask: false };
}

/** 定制简历 → 写邮件 → 等你过目 → 已发出。发生过的墨色，等你的钢笔蓝，没到的灰。 */
export function mailSteps(app: Pick<Application, 'stage' | 'resume_tailored_id'>, thread: MailThreadView | null): TrackNode[] {
  const items = thread?.items ?? [];
  const sent = SENT.has(app.stage) || items.some(i => i.direction === 'out' && i.purpose === 'apply');
  const pending = !sent && items.some(i => i.direction === 'pending' && i.purpose === 'apply');
  const written = sent || pending;
  return [
    { key: 'tailor', label: '定制简历', on: written || !!app.resume_tailored_id },
    { key: 'write', label: '写邮件', on: written },
    { key: 'review', label: '等你过目', on: sent, ask: pending },
    { key: 'sent', label: '已发出', on: sent },
  ];
}

/** 待发的那封投递邮件（进展页右侧就是它的整张预览）。 */
export const pendingApplyMail = (thread: MailThreadView | null): string | null =>
  thread?.items.find(i => i.direction === 'pending' && i.purpose === 'apply')?.action_id ?? null;

const dateOnly = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? undefined : `${d.getMonth() + 1}月${d.getDate()}日`; };

/** 自动回复只当确认信，不算回音（服务端 P2.4 归类为 application_received）。 */
const AUTO_REPLY = 'application_received';

/**
 * 申请对象卡上邮件多出的节：跟进（我们接在自己那封下面发的）、回信（对方真人回的）。按时间排。
 * 跟进 = 发出的、回的是我们自己发出的那封；回信 = 来信、不是自动回复。
 */
export function mailTrackNodes(mails: readonly MailMessage[]): TrackNode[] {
  const outIds = new Set(mails.filter(m => m.direction === 'out' && m.message_id).map(m => m.message_id));
  const at = (m: MailMessage) => m.received_at ?? m.created_at;
  const nodes = mails
    .filter(m => (m.direction === 'out' && !!m.in_reply_to && outIds.has(m.in_reply_to)) || (m.direction === 'in' && m.kind !== AUTO_REPLY))
    .sort((a, b) => at(a).localeCompare(at(b)))
    .map(m => ({ key: `mail_${m.id}`, label: m.direction === 'in' ? '回信' : '跟进', date: dateOnly(at(m)), on: true }));
  // 同一节连着出现几次（来回几封）只留第一次，路上不刷屏
  return nodes.filter((n, i) => i === 0 || nodes[i - 1].label !== n.label);
}

/** 等你的邮件那件在路上叫什么：回信写好了 =「回信」、跟进写好了 =「跟进」、退回来要重发 =「重发」。 */
const MAIL_ASK_LABEL = { followup: '跟进', reply: '回信' } as const;

/** 这份申请上等你的邮件（跟进 / 回信 / 退信重发）各一节，钢笔蓝；key 是那件事的来源 id（点了打开卡组定位到它）。 */
export function mailAskNodes(asks: readonly AskView[]): TrackNode[] {
  return asks.flatMap(a => {
    const m = a.mail;
    const key = a.sources[0]?.id;
    if (!m || !key) return [];
    if (m.bounced) return [{ key, label: '重发', ask: true }];
    return m.purpose === 'apply' ? [] : [{ key, label: MAIL_ASK_LABEL[m.purpose], ask: true }];
  });
}

/** 投递邮件写好了还没发：第一节「邮件发出」就是等你的那一节。 */
export const pendingApplyAsk = (asks: readonly AskView[]): AskView | undefined =>
  asks.find(a => a.mail?.purpose === 'apply' && !a.mail.bounced);
