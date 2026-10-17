/**
 * 一次填表 drive 的结果落库：动作 / 任务 / 接管 / 投递阶段 / submit 待审。
 * 对话里的填表（Session 工具，模型发起）与批量运行器（Global 后台）共用同一套规则，避免两处漂移。
 *
 * 浏览器路由只发 progress / page / result / error 四种行；接管体现在 result.status === 'handoff'，
 * 路由 error 行（501 引擎未就绪 / 400 缺资料 / 401 / 409）一律按失败处理。
 *
 * 停在提交前（stopped_before_submit）不等于"填好了"：先过提交门槛（evaluateSubmitGate），
 * 必填全部已填并读回核验、没有待补 / 没生效 / 站点报错 / 附件没回显 / 草稿，才把 submit 入队等用户批准；
 * 否则填表动作停在 needs_user 并开 missing_info 接管，用户补完后从当前页继续、重新检查。
 */
import type { ActionQueueItem, Repos } from '@career/core';

import { decideSubmit } from './submit-policy';

/** @career/apply 的 SubmitReview（只用到这些字段；requiredTrusted / verified / 行级 verified / code 是引擎可选的核验结果，有就优先用）。 */
interface SubmitReviewRowLike { fieldId?: string; label?: string; required?: boolean; status?: string; reason?: string; verified?: boolean; reasonCode?: string }
interface SubmitReviewLike { rows: SubmitReviewRowLike[]; attention: number; requiredTotal: number; requiredFilled: number; formSignature?: string; openAnswersHash?: string; verified?: boolean; /** 引擎判断 requiredTotal 是否可信（认出的必填数和页面星号对得上） */ requiredTrusted?: boolean; requiredNote?: string }
const parseObj = (raw: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; } };

/** 一项还没过关的字段：给用户看的名字 + 原因（人话）。 */
export interface SubmitGap { label: string; reason: string; status: string; required: boolean }
export interface SubmitGate {
  /** true：必填全部已填并读回核验通过，且没有待补 / 没生效 / 站点报错 / 附件没回显 / 草稿 → 才会入队提交。 */
  ready: boolean;
  requiredFilled: number | null;
  requiredTotal: number | null;
  gaps: SubmitGap[];
}

const GAP_REASON: Record<string, string> = {
  empty: '必填项还是空的', mismatch: '填进去的值没有生效', needs_user: '需要你来填', draft: '开放题草稿，等你确认后才会填',
  site_error: '网站提示的校验错误', upload_unconfirmed: '附件没有看到上传成功', unverified: '读回核对没有通过',
};
const asList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * 提交门槛：只依赖引擎 result 里已有的字段；引擎给了读回核验（review.verified / 行级 verified）就优先用。
 * 没有填后检查、必填数不可信（读不到任何行 / 引擎说没核验 / 数字对不上）都算没过关——
 * 宁可让用户补一下，也不把没填完的表交去提交。
 */
export function evaluateSubmitGate(result: Record<string, unknown>): SubmitGate {
  const review = result.review as SubmitReviewLike | undefined;
  const gaps: SubmitGap[] = [];
  const seen = new Set<string>();
  const add = (label: string | undefined, status: string, reason?: string, required = true) => {
    const name = label ?? '没认出名字的字段';
    const key = `${status}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push({ label: name, status, reason: reason ?? GAP_REASON[status] ?? '需要你看一下', required });
  };
  const rows = review && Array.isArray(review.rows) ? review.rows : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // empty_optional：选填留空，不算缺项
    if (row.status === 'empty_optional') continue;
    if (row.status && row.status !== 'ok') add(strOf(row.label), row.status, strOf(row.reason), row.required !== false);
    else if (row.verified === false) add(strOf(row.label), 'unverified', strOf(row.reason), row.required !== false);
  }
  // 驱动记录兜底：没有 review 或 review 漏掉的项
  for (const p of asList(result.needsUser)) add(strOf(p.label), 'needs_user', strOf(p.note));
  for (const p of asList(result.drafts)) add(strOf(p.label), 'draft', undefined, false);
  for (const m of asList(result.mismatches)) add(strOf(m.label), 'mismatch', strOf(m.actual) ? `页面上是「${strOf(m.actual)}」，没有生效` : undefined);
  for (const u of asList(result.uploads)) if (u.echoed !== true) add('简历附件', 'upload_unconfirmed', strOf(u.evidence));

  if (!review) {
    add('填后检查', 'unverified', '没有拿到填后检查结果，不知道必填项是否都填好了');
    return { ready: false, requiredFilled: null, requiredTotal: null, gaps };
  }
  const total = isCount(review.requiredTotal) ? review.requiredTotal : null;
  const filled = isCount(review.requiredFilled) ? review.requiredFilled : null;
  const trusted = total !== null && filled !== null && filled <= total && rows.length > 0 && review.verified !== false && review.requiredTrusted !== false;
  if (!trusted) add('必填项核对', 'unverified', strOf(review.requiredNote) ?? '没能读回表单核对必填项');
  else if (filled < total && !gaps.some(g => g.required)) add('必填项', 'empty', `还有 ${total - filled} 个必填项没填好`);
  return { ready: trusted && filled === total && gaps.length === 0, requiredFilled: filled, requiredTotal: total, gaps };
}

/** 岗位在文案里的叫法：没有公司和岗位名时说"这个岗位"。 */
export function jobLabel(job: { company_name?: string | null; title?: string | null } | undefined | null): string {
  const title = job?.title && job.title.trim() !== '未命名岗位' ? job.title.trim() : '';
  const text = `${job?.company_name?.trim() ?? ''} ${title}`.trim();
  return text || '这个岗位';
}

/** 提交卡片 / 给模型的说明里那句"填到哪了"，按实际数字生成。 */
export function gateHeadline(gate: Pick<SubmitGate, 'requiredFilled' | 'requiredTotal'>, submitButton?: string): string {
  const where = submitButton ? `，停在「${submitButton}」前` : '，停在提交前';
  if (gate.requiredTotal) return `必填 ${gate.requiredFilled}/${gate.requiredTotal} 已填好并核对过${where}`;
  return `表单已填写并核对过（这张表没有标必填项）${where}`;
}

/** "还差 N 项要你补"：列出前几项的名字。 */
export function gapsHeadline(gaps: readonly SubmitGap[]): string {
  const names = gaps.slice(0, 5).map(g => g.label).join('、');
  return `还差 ${gaps.length} 项要你补${names ? `：${names}${gaps.length > 5 ? ' 等' : ''}` : ''}`;
}

export type DriveEvent = Record<string, unknown>;
export type DriveOutcome =
  | { kind: 'handoff'; handoffId: string; reason: string; userAction?: string; message: string; finalUrl?: string; summary: Record<string, unknown>; /** 停在提交前但没过提交门槛时的缺项 */ gate?: SubmitGate }
  | { kind: 'done'; submitActionId: string; pending: number; summary: Record<string, unknown>; submitButton?: string; gate: SubmitGate; headline: string; /** auto 模式 / 自学习免审时已直接批准 */ autoApproved?: 'auto' | 'learned'; decision?: string }
  | { kind: 'failed'; blocked: boolean; message: string; summary?: Record<string, unknown> };

export interface PersistDeps {
  repos: Repos;
  action: ActionQueueItem;
  taskId: string;
  events: DriveEvent[];
  /** 数据变更广播（表名）。 */
  changed: (...tables: string[]) => void;
  /** 有 submit 进待审时通知对话内审核卡片（data：卡片里的审阅清单等）。 */
  review?: (actionIds: string[], kind: string, summary: string, data?: Record<string, unknown>) => void;
}

export function pickDriveResult(events: DriveEvent[]): { result?: Record<string, unknown>; errorLine?: { status?: number; error?: string } } {
  const errorLine = events.find(e => e.type === 'error') as { status?: number; error?: string } | undefined;
  const result = [...events].reverse().find(e => e.type === 'result' && e.op === 'drive')?.result as Record<string, unknown> | undefined;
  return { result, errorLine };
}

export function summarizeDriveResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    status: result.status, reason: result.reason, message: result.message, userAction: result.userAction, finalUrl: result.finalUrl, adapter: result.adapterId,
    filled: result.filled, needsUser: result.needsUser, drafts: result.drafts, mismatches: result.mismatches, uploads: result.uploads,
    escalations: result.escalations, layersUsed: result.layersUsed, submitButton: result.submitButton, loginFilled: result.loginFilled,
    review: result.review,
    sections: Array.isArray(result.pages) ? (result.pages as Array<{ sections?: unknown }>).flatMap(p => (Array.isArray(p.sections) ? p.sections : [])) : undefined,
  };
}

/** 把 NDJSON 事件落库，返回结构化结果。调用方负责 run 注册表与 SSE 接管事件。 */
export function persistDriveOutcome(deps: PersistDeps): DriveOutcome {
  const { repos: r, action, taskId, events } = deps;
  const { result, errorLine } = pickDriveResult(events);
  const fail = (message: string, summary?: Record<string, unknown>, blocked = false): DriveOutcome => {
    r.setActionStatus(action.id, 'failed', { error: message, ...(summary ? { summary } : {}) });
    r.updateTask(taskId, { status: 'failed' });
    if (action.application_id) { try { r.transition(action.application_id, 'blocked', message, { blocker_reason: message, next_action: '查看阻塞原因后重试' }); } catch { /* ignore */ } }
    deps.changed('task', 'action_queue', 'application');
    return { kind: 'failed', blocked, message, summary };
  };
  if (!result) return fail(errorLine ? `${errorLine.error ?? '浏览器路由报错'}（HTTP ${errorLine.status ?? '?'}）` : '浏览器没有返回填表结果');
  const summary = summarizeDriveResult(result);
  // 用户接管期间自己填好的字段 → 答案库（未确认），下次同类问题直接用原话
  if (Array.isArray(result.learned)) {
    for (const item of result.learned as Array<{ label?: string; value?: string }>) {
      if (!item?.label || !item?.value) continue
      if (r.findAnswer(item.label)) continue
      try { r.saveAnswer({ question_key: item.label, question_text: item.label, answer: item.value, high_impact: false, confirmed: false, source: 'learned', event: 'corrected', application_id: action.application_id }); } catch { /* ignore */ }
    }
    if ((result.learned as unknown[]).length) deps.changed('answer_bank');
  }
  const count = (k: string) => (Array.isArray(result[k]) ? (result[k] as unknown[]).length : 0);
  const status = String(result.status ?? '');
  const finalUrl = typeof result.finalUrl === 'string' ? result.finalUrl : undefined;
  const message = typeof result.message === 'string' ? result.message : status;

  if (status === 'handoff') {
    const reason = String(result.reason ?? 'user_request');
    const userAction = typeof result.userAction === 'string' ? result.userAction : undefined;
    const h = r.openHandoff(reason as never, { actionId: action.id, taskId, message });
    r.setActionStatus(action.id, 'needs_user', summary);
    if (action.application_id) { try { r.transition(action.application_id, 'needs_user', message, { page_url: finalUrl, blocker_reason: `${reason}: ${message}`, next_action: '处理接管后继续' }); } catch { /* ignore */ } }
    deps.changed('handoff', 'task', 'action_queue', 'application');
    return { kind: 'handoff', handoffId: h.id, reason, userAction, message, finalUrl, summary };
  }
  if (status === 'stopped_before_submit') {
    const fillPayload = parseObj(action.payload_json);
    const job = typeof fillPayload.job_id === 'string' ? r.getJob(fillPayload.job_id) : undefined;
    const submitButton = typeof result.submitButton === 'string' ? result.submitButton : undefined;
    const gate = evaluateSubmitGate(result);
    if (!gate.ready) {
      // 没过门槛：不入队提交。填表动作停在 needs_user + missing_info 接管，用户补完后从当前页继续、重新检查
      const gapText = gapsHeadline(gate.gaps);
      const h = r.openHandoff('missing_info', { actionId: action.id, taskId, message: gapText });
      r.setActionStatus(action.id, 'needs_user', { ...summary, gate });
      if (action.application_id) { try { r.transition(action.application_id, 'needs_user', gapText, { page_url: finalUrl, blocker_reason: gapText, next_action: '补齐缺项后继续检查' }); } catch { /* ignore */ } }
      deps.changed('handoff', 'task', 'action_queue', 'application');
      return { kind: 'handoff', handoffId: h.id, reason: 'missing_info', userAction: `${gapText}。补好后告诉我，我从当前页接着检查`, message: gapText, finalUrl, summary, gate };
    }
    r.setActionStatus(action.id, 'done', summary);
    const review = result.review as SubmitReviewLike;
    const packet = typeof fillPayload.packet_id === 'string' ? r.getPacket(fillPayload.packet_id) : undefined;
    const resumeSha = packet ? packet.resume_pdf_sha256 ?? packet.resume_sha256 : null;
    const filled = Array.isArray(result.filled) ? (result.filled as Array<{ fieldId?: string; label?: string; value?: string; source?: string }>).map(f => ({ fieldId: f.fieldId, label: f.label, value: f.value, source: f.source })) : [];
    const reviewSummary = { rows: review.rows, attention: review.attention, requiredTotal: review.requiredTotal, requiredFilled: review.requiredFilled };
    // 审核的对象就是这份 payload：页面停在哪个按钮、填了什么、审阅清单、两枚免审指纹；批准即绑定这些内容
    const submitAction = r.enqueueAction('submit', {
      url: finalUrl, submitButton, application_id: action.application_id, fill_action_id: action.id,
      ...(packet ? { packet_id: packet.id } : {}),
      summary: { filled: count('filled'), needsUser: count('needsUser'), drafts: count('drafts'), mismatches: count('mismatches') },
      filled,
      review: reviewSummary,
      formSignature: review.formSignature ?? null, openAnswersHash: review.openAnswersHash ?? null, resumeSha,
    }, action.application_id);
    r.updateTask(taskId, { status: 'done', progress: 1 });
    const decision = decideSubmit(r, { attention: review.attention, formSignature: review.formSignature, openAnswersHash: review.openAnswersHash, resumeSha });
    if (decision.approve) r.reviewActions([submitAction.id], 'approved', decision.by);
    if (action.application_id) {
      try { r.db.update('application', action.application_id, { page_url: finalUrl ?? null, next_action: decision.approve ? '正在提交' : '审核后提交', blocker_reason: null, updated_at: new Date().toISOString() }); } catch { /* ignore */ }
    }
    const headline = gateHeadline(gate, submitButton);
    if (!decision.approve) {
      deps.review?.([submitAction.id], 'submit', `「${jobLabel(job)}」${headline}`, {
        job: jobLabel(job), headline, submit_button: submitButton ?? null, review: reviewSummary,
        note: '看一遍下面的清单，批准后产品替你点提交；没批准之前不会提交。',
      });
    }
    deps.changed('task', 'action_queue', 'application');
    return { kind: 'done', submitActionId: submitAction.id, pending: 0, summary, submitButton, gate, headline, autoApproved: decision.approve ? decision.by : undefined, decision: decision.reason };
  }
  return fail(message, summary, status === 'blocked');
}
