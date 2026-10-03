/**
 * 一次填表 drive 的结果落库：动作 / 任务 / 接管 / 投递阶段 / submit 待审。
 * `apply_run`（Session 工具，模型发起）与批量运行器（Global 后台）共用同一套规则，避免两处漂移。
 *
 * 浏览器路由只发 progress / page / result / error 四种行；接管体现在 result.status === 'handoff'，
 * 路由 error 行（501 引擎未就绪 / 400 缺资料 / 401 / 409）一律按失败处理。
 */
import type { ActionQueueItem, Repos } from '@career/core';

export type DriveEvent = Record<string, unknown>;
export type DriveOutcome =
  | { kind: 'handoff'; handoffId: string; reason: string; userAction?: string; message: string; finalUrl?: string; summary: Record<string, unknown> }
  | { kind: 'done'; submitActionId: string; pending: number; summary: Record<string, unknown>; submitButton?: string }
  | { kind: 'failed'; blocked: boolean; message: string; summary?: Record<string, unknown> };

export interface PersistDeps {
  repos: Repos;
  action: ActionQueueItem;
  taskId: string;
  events: DriveEvent[];
  /** 数据变更广播（表名）。 */
  changed: (...tables: string[]) => void;
  /** 有 submit 进待审时通知对话内审核卡片。 */
  review?: (actionIds: string[], kind: string, summary: string) => void;
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
    r.setActionStatus(action.id, 'done', summary);
    const submitAction = r.enqueueAction('submit', { url: finalUrl, submitButton: result.submitButton, summary: { filled: count('filled'), needsUser: count('needsUser'), drafts: count('drafts'), mismatches: count('mismatches') } }, action.application_id);
    r.updateTask(taskId, { status: 'done', progress: 1 });
    const pending = count('needsUser') + count('drafts') + count('mismatches');
    if (action.application_id) {
      try {
        if (pending > 0) r.transition(action.application_id, 'needs_user', `需要你补充 ${pending} 项后再提交`, { page_url: finalUrl, next_action: '补充缺项后审核提交' });
        else r.db.update('application', action.application_id, { page_url: finalUrl ?? null, next_action: '审核后提交', blocker_reason: null, updated_at: new Date().toISOString() });
      } catch { /* ignore */ }
    }
    deps.review?.([submitAction.id], 'submit', `表单已填好${result.submitButton ? `，停在「${String(result.submitButton)}」前` : ''}，确认后由你本人提交`);
    deps.changed('task', 'action_queue', 'application');
    return { kind: 'done', submitActionId: submitAction.id, pending, summary, submitButton: typeof result.submitButton === 'string' ? result.submitButton : undefined };
  }
  return fail(message, summary, status === 'blocked');
}
