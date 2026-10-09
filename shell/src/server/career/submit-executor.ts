/**
 * 提交执行器（Global 侧车）：执行已批准的 submit 动作——用户本人批准、auto 模式、自学习免审三种来源都走这里。
 *
 *  - 每 3 秒找一次 approved 的 submit，逐个执行（同一时间只提交一份）；审批路由批准后也会立即踢一下。
 *  - 执行前 claimAction（核对批准时的内容哈希，防重复提交）；在这份网申自己的页面上 runOperation('submit')。
 *  - 结果：
 *    submitted → 动作 done、投递推进到 applied（submission_evidence 记成功依据）、页面关闭；
 *                页面上被用户改过的值写回答案库（corrected 事件，进上传队列）；
 *    needs_user / failed → 回到待审（批准作废），用户在页面上处理后重新批准；
 *    handoff → 开接管，用户处理完在卡片里确认结果；
 *    uncertain → 不重试（避免重复投递），动作 needs_user，等用户确认"已投递 / 重新提交"。
 *  - 每次结果都更新自学习计数（submit-policy.recordSubmitOutcome）。
 */
import type { ActionQueueItem, Repos } from '@career/core';

import { recordSubmitOutcome } from './submit-policy';

export type SubmitRunner = (body: Record<string, unknown>, onEvent: (ev: Record<string, unknown>) => void) => Promise<Array<Record<string, unknown>>>;

export interface SubmitExecutorDeps {
  repos: Repos;
  run: SubmitRunner;
  broadcast: (event: string, data: unknown) => void;
  sessionId?: () => string;
}

export interface SubmitOutcome { actionId: string; status: string; message: string }

const parse = (raw: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; } };

export async function executeSubmitAction(deps: SubmitExecutorDeps, actionId: string): Promise<SubmitOutcome> {
  const r = deps.repos;
  const sid = deps.sessionId?.() ?? 'global';
  const changed = (...tables: string[]) => deps.broadcast('career:data-changed', { sessionId: sid, tables });
  const claim = r.claimAction(actionId);
  if (!claim.ok) {
    changed('action_queue');
    return { actionId, status: 'skipped', message: claim.reason === 'content_changed' ? '批准后内容有变化，已退回待审' : '已不是待执行状态' };
  }
  const action = claim.action;
  const payload = parse(action.payload_json);
  const appId = action.application_id ?? (typeof payload.application_id === 'string' ? payload.application_id : null);
  deps.broadcast('career:progress', { sessionId: sid, phase: 'submit', message: '正在提交网申', actionId });
  const events: Array<Record<string, unknown>> = [];
  try {
    await deps.run({ op: 'submit', actionId, applicationId: appId, submitButton: payload.submitButton, filled: payload.filled }, ev => { events.push(ev); });
  } catch (error) {
    events.push({ type: 'error', status: 500, error: error instanceof Error ? error.message : String(error) });
  }
  const errorLine = events.find(e => e.type === 'error');
  const result = [...events].reverse().find(e => e.type === 'result' && e.op === 'submit')?.result as Record<string, unknown> | undefined;
  const fingerprint = { formSignature: str(payload.formSignature), openAnswersHash: str(payload.openAnswersHash), resumeSha: str(payload.resumeSha) };

  if (!result) {
    const message = `${String(errorLine?.error ?? '浏览器没有返回提交结果')}`;
    if (errorLine?.code === 'BROWSER_BUSY') { r.requeueAction(actionId); changed('action_queue'); return { actionId, status: 'busy', message }; }
    r.reopenAction(actionId, { error: message });
    recordSubmitOutcome(r, { ...fingerprint, approvedBy: action.approved_by, status: 'failed', edits: 0 });
    note(r, appId, `提交没有执行：${message}`);
    changed('action_queue', 'application');
    deps.broadcast('career:review', { sessionId: sid, actionIds: [actionId], kind: 'submit', summary: `提交没有执行：${message}` });
    return { actionId, status: 'failed', message };
  }

  const status = String(result.status ?? 'failed');
  const message = String(result.message ?? status);
  const edits = Array.isArray(result.edits) ? result.edits as Array<{ label?: string; before?: string; after?: string }> : [];
  recordSubmitOutcome(r, { ...fingerprint, approvedBy: action.approved_by, status, edits: edits.length });
  // 页面上被用户改过的值：以用户为准写回答案库（下次直接用），并进上传队列
  for (const e of edits) {
    if (!e.label || !e.after) continue;
    try { r.saveAnswer({ question_key: e.label, question_text: e.label, answer: e.after, confirmed: true, source: 'page_edit', event: 'corrected', application_id: appId }); } catch { /* ignore */ }
  }

  if (status === 'submitted') {
    r.setActionStatus(actionId, 'done', result);
    if (appId) {
      try {
        const app = r.getApplication(appId);
        if (app && !['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired'].includes(app.stage)) r.jumpTo(appId, 'applied', `已提交（${approvalLabel(action)}）`, { submission_evidence: `submit:${String(result.evidence ?? result.finalUrl ?? '')}`, next_action: null, blocker_reason: null });
        note(r, appId, `网申已提交：${message}${edits.length ? `；提交前你在页面上改了 ${edits.length} 项，已更新答案库` : ''}`);
      } catch { /* 阶段已在终态 */ }
    }
    changed('action_queue', 'application', 'application_history', 'answer_bank', 'dossier_note');
    deps.broadcast('career:focus', { sessionId: sid, surface: 'dossier', application_id: appId, note: '网申已提交' });
    return { actionId, status, message };
  }
  if (status === 'handoff') {
    r.openHandoff((String(result.reason ?? 'submit_confirm')) as never, { actionId, message });
    if (appId) { try { r.transition(appId, 'needs_user', message, { blocker_reason: message, next_action: '处理后确认是否已投递' }); } catch { /* ignore */ } }
    changed('action_queue', 'handoff', 'application');
    return { actionId, status, message };
  }
  if (status === 'uncertain') {
    // 不能重试：可能已经投出去了。等用户在页面上确认。
    r.setActionStatus(actionId, 'needs_user', result);
    if (appId) { try { r.transition(appId, 'needs_user', message, { next_action: '到页面确认是否已投递成功' }); } catch { /* ignore */ } }
    changed('action_queue', 'application');
    deps.broadcast('career:review', { sessionId: sid, actionIds: [actionId], kind: 'submit', summary: message });
    return { actionId, status, message };
  }
  // needs_user / failed：回到待审，用户在页面上处理后重新批准
  r.reopenAction(actionId, result);
  note(r, appId, `提交没成功：${message}`);
  changed('action_queue', 'application', 'dossier_note');
  deps.broadcast('career:review', { sessionId: sid, actionIds: [actionId], kind: 'submit', summary: `提交没成功：${message}；在页面上处理好后重新批准` });
  return { actionId, status, message };
}

/** 用户确认结果（uncertain / 接管后）：已投递 → applied；没投出去 → 回到待审。 */
export function confirmSubmitResult(repos: Repos, actionId: string, submitted: boolean): ActionQueueItem | undefined {
  const a = repos.getAction(actionId);
  if (!a || a.kind !== 'submit') return undefined;
  for (const h of repos.openHandoffs()) if (h.action_id === actionId) repos.closeHandoff(h.id, submitted ? 'user_confirmed_submitted' : 'user_confirmed_not_submitted');
  if (submitted) {
    repos.setActionStatus(actionId, 'done', { status: 'submitted', evidence: 'user_confirmed' });
    if (a.application_id) { try { repos.jumpTo(a.application_id, 'applied', '你确认已投递', { submission_evidence: 'user_confirmed' }); } catch { /* ignore */ } }
  } else repos.reopenAction(actionId);
  return repos.getAction(actionId);
}

function approvalLabel(a: ActionQueueItem): string {
  return a.approved_by === 'auto' ? 'auto 模式' : a.approved_by === 'learned' ? '自学习免审' : '你批准后';
}
function note(r: Repos, appId: string | null, content: string): void {
  if (!appId) return;
  try { r.addDossierNote({ application_id: appId, kind: 'note', content }); } catch { /* ignore */ }
}
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }

/** Global 轮询：逐个执行已批准的 submit。 */
export class SubmitExecutor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly deps: SubmitExecutorDeps & { pollMs?: number; log?: (m: string) => void }) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.pollMs ?? 3000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** 跑一轮：返回本轮执行的结果。 */
  async tick(): Promise<SubmitOutcome[]> {
    if (this.running) return [];
    this.running = true;
    const out: SubmitOutcome[] = [];
    try {
      for (const a of this.deps.repos.listActions('approved').filter(x => x.kind === 'submit')) {
        const res = await executeSubmitAction(this.deps, a.id);
        this.deps.log?.(`[submit] ${a.id} → ${res.status}: ${res.message}`);
        out.push(res);
        if (res.status === 'busy') break;
      }
    } finally { this.running = false; }
    return out;
  }
}
