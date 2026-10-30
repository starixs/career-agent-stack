/**
 * 归档之后用户点一下就能改：
 *  - assignIntake：同一家几份在投、对不上是哪一份时，用户在候选里点一份（不用打字说明）。
 *  - correctIntake：读错了（把面试读成拒信、把广告当笔试），用户点「不对」再选正确的类型。
 *    撤掉这封信带来的推进和时间点，按正确类型重新落库；漏斗不留误判，卷宗记一笔更正（undoLastStage）。
 * 两者都复用 intake.applyTriage，落库规则只有一份。
 */
import type { InboxItem, InboxKind } from '@career/core';

import { applyTriage, dataChanged, triageText, type IntakeDeps, type IntakeResult, type TriageResult } from './intake';

/** 用户点「不对」时能选的正确类型；ignored = 和求职无关。 */
export const CORRECTABLE_KINDS = ['interview_invite', 'written_test', 'assessment', 'rejection', 'offer', 'ignored'] as const;
export type CorrectKind = typeof CORRECTABLE_KINDS[number];

const KIND_LABEL: Record<string, string> = {
  interview_invite: '面试邀请', written_test: '笔试通知', assessment: '测评', rejection: '拒信', offer: 'Offer', ignored: '无关邮件',
  application_received: '投递确认', jd: '岗位', referral: '内推', deadline: '截止提醒', other: '其他',
};
/** 这类信归档时会把申请推到哪个阶段：撤回时据此判断「最近那次推进是不是这封信推的」。 */
const STAGE_OF_KIND: Partial<Record<InboxKind, string>> = { interview_invite: 'interview', rejection: 'rejected', offer: 'offer' };

function parsedOf(item: InboxItem): TriageResult | null {
  if (!item.parsed_json) return null;
  try { return JSON.parse(item.parsed_json) as TriageResult; } catch (error) {
    console.warn(`[career-intake] parsed_json of ${item.id} unreadable:`, error instanceof Error ? error.message : error);
    return null;
  }
}

function requireItem(deps: IntakeDeps, itemId: string): InboxItem {
  const item = deps.repos.getInboxItem(itemId);
  if (!item) throw new Error(`收件箱条目不存在：${itemId}`);
  return item;
}

/** 用户在候选里点了一份：用已经抽好的字段直接落库，不再调模型。 */
export async function assignIntake(deps: IntakeDeps, itemId: string, applicationId: string): Promise<IntakeResult> {
  const item = requireItem(deps, itemId);
  if (!deps.repos.getApplication(applicationId)) throw new Error(`投递不存在：${applicationId}`);
  const nowIso = deps.now?.() ?? new Date().toISOString();
  const input = { text: item.raw_text, source: item.source, mail_message_id: item.mail_message_id, application_id: applicationId };
  const triage = parsedOf(item) ?? await triageText(deps, item.raw_text, input, nowIso);
  return applyTriage(deps, item, { ...triage, match: { application_id: applicationId } }, input, nowIso);
}

/** 这封信关联到的那份申请（面试、Offer 挂在申请上）。 */
function applicationOf(deps: IntakeDeps, item: InboxItem): string | null {
  if (!item.linked_id) return null;
  if (item.linked_type === 'application') return item.linked_id;
  if (item.linked_type === 'interview') return deps.repos.db.get<{ application_id: string | null }>('SELECT application_id FROM interview WHERE id=?', [item.linked_id])?.application_id ?? null;
  if (item.linked_type === 'offer') return deps.repos.db.get<{ application_id: string | null }>('SELECT application_id FROM offer WHERE id=?', [item.linked_id])?.application_id ?? null;
  if (item.linked_type === 'deadline') return deps.repos.getDeadline(item.linked_id)?.application_id ?? null;
  return null;
}

/** 撤掉这封信带来的东西：它推的那次阶段、它建的还开着的时间点。 */
function undoEffects(deps: IntakeDeps, item: InboxItem, appId: string, reason: string): void {
  const r = deps.repos;
  const app = r.getApplication(appId);
  const last = r.db.get<{ note: string | null }>('SELECT note FROM application_history WHERE application_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [appId]);
  const pushedByThis = !!app && !!item.kind && STAGE_OF_KIND[item.kind] === app.stage && !!last?.note?.startsWith('收到');
  if (pushedByThis) r.undoLastStage(appId, reason);
  // 这封信建的时间点：同一份申请上、归档那一刻建的、还没处理的
  const until = item.processed_at ?? item.created_at;
  for (const d of r.listDeadlines({ status: 'open_or_missed', application_id: appId })) {
    if (d.created_at >= item.created_at && d.created_at <= until && (d.source === 'mail' || d.source === 'inbox')) r.setDeadlineStatus(d.id, 'cancelled');
  }
}

/**
 * 用户点「不对」、选了正确的类型。有模型时带着正确类型重新抽一次字段（比如面试时间），拿不到就沿用原来的字段。
 * 选「无关」就撤掉带来的东西、把信放进已忽略。
 */
export async function correctIntake(deps: IntakeDeps, itemId: string, kind: CorrectKind): Promise<IntakeResult> {
  const item = requireItem(deps, itemId);
  if (item.kind === kind) throw new Error(`这条已经是「${KIND_LABEL[kind]}」`);
  const reason = `用户更正：这封信是「${KIND_LABEL[kind]}」，不是「${KIND_LABEL[item.kind ?? 'other'] ?? item.kind}」`;
  const appId = applicationOf(deps, item);
  if (appId) undoEffects(deps, item, appId, reason);
  const nowIso = deps.now?.() ?? new Date().toISOString();
  if (kind === 'ignored') {
    const dismissed = deps.repos.resolveInboxItem(item.id, { status: 'dismissed', note: reason });
    dataChanged(deps, ['inbox_item', 'application', 'application_history', 'deadline', 'dossier_note']);
    return { item: dismissed, triage: parsedOf(item), created: { deadline_ids: [] }, focus: { surface: 'inbox', id: item.id }, summary: '已放进已忽略' };
  }
  const input = { text: item.raw_text, source: item.source, mail_message_id: item.mail_message_id, application_id: appId };
  let triage = parsedOf(item) ?? {};
  if (deps.llm) {
    try { triage = await triageText(deps, item.raw_text, input, nowIso, kind); } catch (error) {
      console.warn(`[career-intake] re-triage ${item.id} as ${kind} failed, reuse old fields:`, error instanceof Error ? error.message : error);
    }
  }
  const result = await applyTriage(deps, item, { ...triage, kind, ...(appId ? { match: { application_id: appId } } : {}) }, input, nowIso);
  dataChanged(deps, ['application', 'application_history', 'deadline', 'dossier_note']);
  return result;
}
