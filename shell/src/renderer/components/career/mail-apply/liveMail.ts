/**
 * 邮件申请在申请对象卡那条路上多出的几节。
 * 「这份申请走邮件」：岗位有投递邮箱（apply_email），或投递凭据以 `mail:` 开头（已发出的）。
 */
import type { AskView } from '../delivery/deliveryApi';
import type { Application, ApplicationStage, MailMessage } from '../types';

/** 和申请对象卡那条路的节同形（delivery/applicationTrack.ts TrackNode）：墨色 on、钢笔蓝 ask、其余灰。 */
export interface MailTrackNode { key: string; label: string; date?: string; on?: boolean; ask?: boolean }
type TrackNode = MailTrackNode;

const SENT = new Set<ApplicationStage>(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);
const MAIL_EVIDENCE = 'mail:';

export function isMailApplication(app: Pick<Application, 'submission_evidence'> & { apply_email?: string | null }): boolean {
  return !!app.apply_email || (app.submission_evidence ?? '').startsWith(MAIL_EVIDENCE);
}

/** 已经投出去过（和网申进展页统计同口径）。 */
export const isSentStage = (stage: ApplicationStage): boolean => SENT.has(stage);

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
