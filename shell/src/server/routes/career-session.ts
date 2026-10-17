/**
 * Session 路由 `/api/career-session/*`（docs/API.md）：依赖当前对话会话。
 *
 * - review：对话内审核卡片回传，内部同 Global review，然后 broadcast `career:data-changed`。
 *   填表不需要事前审批（apply_prepare 准备好就直接填）；待投清单 / 旧数据里还在待审的 fill_form 在对话卡片上
 *   同意后由助理接着调 apply_run（渲染层把决定发进对话），这里不交给后台，避免两个执行者抢同一份网申；
 *   submit 由 Global 提交执行器轮询接走。
 * - takeover：用户在对话里点"我来接管 / 交还"；更新 run 状态机（内存）并通过
 *   Global 的 `/api/career/browser/control` 切换浏览器控制权（url/token 来自 Browser capability）。
 */
import type { Repos } from '@career/core';

import { acquireBrowserCapability } from '../browser-host/capability-client';
import { getRepos } from '../career/db';
import { resetPageTrust } from '../career/submit-policy';
import { getRunRegistry, type RunRegistry } from '../career/runs';
import { broadcast as sseBroadcast } from '../sse';
import { fail, ok } from './career';

export type BrowserControl = 'agent' | 'human';

export interface CareerSessionRouteDeps {
  repos?: Repos;
  runs?: RunRegistry;
  broadcast?: (event: string, data: unknown) => void;
  sessionId?: () => string;
  /** 切换托管浏览器控制权；缺省走 Browser capability → Global 路由。 */
  browserControl?: (control: BrowserControl, reason?: string) => Promise<void>;
}

/** 通过 Browser capability 调 Global 的 `/api/career/browser/control`。 */
export async function controlCareerBrowser(control: BrowserControl, reason?: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const capability = await acquireBrowserCapability();
  // capability.url 指向 Global 的 `/mcp/playwright`；career 路由在同一 origin 下
  const response = await fetchImpl(`${new URL(capability.url).origin}/api/career/browser/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability.token}` },
    body: JSON.stringify({ control, ...(reason ? { reason } : {}) }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = ((await response.json()) as { error?: string }).error ?? ''; } catch { /* ignore */ }
    throw new Error(`浏览器控制切换失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function handleCareerSessionRoute(pathname: string, request: Request, deps: CareerSessionRouteDeps = {}): Promise<Response | null> {
  if (!pathname.startsWith('/api/career-session/')) return null;
  if (request.method.toUpperCase() !== 'POST') return fail('只支持 POST', 405);
  const broadcast = deps.broadcast ?? sseBroadcast;
  const sessionId = deps.sessionId ?? (() => 'default');
  const body = await readBody(request);

  if (pathname === '/api/career-session/review') {
    const ids = Array.isArray(body.actionIds) ? body.actionIds.filter((x): x is string => typeof x === 'string') : [];
    const decision = body.decision;
    if (!ids.length) return fail('actionIds 不能为空');
    if (decision !== 'approved' && decision !== 'rejected') return fail("decision 必须是 'approved' | 'rejected'");
    const repos = deps.repos ?? await getRepos();
    const reviewed = ids.map(id => repos.getAction(id)).filter((a): a is NonNullable<typeof a> => !!a && a.status === 'pending_review');
    const n = repos.reviewActions(ids, decision, 'user');
    // 拒绝提交：这张表的自学习计数清零（批准的提交由 Global 的提交执行器在几秒内执行）
    if (decision === 'rejected') {
      for (const a of reviewed.filter(x => x.kind === 'submit')) { try { const p = JSON.parse(a.payload_json) as { formSignature?: string }; resetPageTrust(repos, p.formSignature); } catch { /* ignore */ } }
    }
    broadcast('career:data-changed', { sessionId: sessionId(), tables: ['action_queue'] });
    return ok({ n });
  }

  if (pathname === '/api/career-session/takeover') {
    const runId = typeof body.runId === 'string' ? body.runId : '';
    const action = body.action;
    if (!runId) return fail('runId 不能为空');
    if (action !== 'take' && action !== 'handback') return fail("action 必须是 'take' | 'handback'");
    const runs = deps.runs ?? getRunRegistry({ broadcast, sessionId });
    const run = runs.get(runId);
    const control = deps.browserControl ?? controlCareerBrowser;
    const repos = deps.repos ?? await getRepos();
    if (!run) {
      // 不是本会话发起的 run（例如 Global 批量运行器）：按数据库里的接管记录处理，交回即关闭等待中的填表接管
      let warning: string | undefined;
      try { await control(action === 'take' ? 'human' : 'agent', action === 'take' ? 'user_request' : undefined); } catch (error) { warning = error instanceof Error ? error.message : String(error); }
      let closed = 0;
      if (action === 'handback') {
        for (const h of repos.openHandoffs()) {
          const a = h.action_id ? repos.getAction(h.action_id) : undefined;
          if (!a || a.kind === 'fill_form') { try { repos.closeHandoff(h.id, typeof body.resumedFromStep === 'string' ? body.resumedFromStep : 'handback'); closed++; } catch { /* ignore */ } }
        }
        if (closed) broadcast('career:data-changed', { sessionId: sessionId(), tables: ['handoff', 'task', 'action_queue'] });
      }
      broadcast('career:takeover', { sessionId: sessionId(), runId, state: action === 'take' ? 'human_active' : 'resuming' });
      return ok({ run: null, closedHandoffs: closed, ...(warning ? { warning } : {}) });
    }
    try {
      let warning: string | undefined;
      if (action === 'take') {
        if (run.state === 'running') runs.pause(runId, 'user_request', { message: '用户请求接管' });
        if (runs.get(runId)!.state === 'paused') runs.transition(runId, 'human_active');
        else if (runs.get(runId)!.state !== 'human_active') return fail(`当前状态 ${run.state} 不能接管`, 409);
        try { await control('human', String(runs.get(runId)!.reason ?? 'user_request')); } catch (error) { warning = error instanceof Error ? error.message : String(error); }
      } else {
        const cur = runs.get(runId)!;
        if (cur.state !== 'human_active' && cur.state !== 'paused') return fail(`当前状态 ${cur.state} 不能交还`, 409);
        runs.transition(runId, 'resuming');
        try { await control('agent'); } catch (error) { warning = error instanceof Error ? error.message : String(error); }
        if (cur.handoffId) {
          try { repos.closeHandoff(cur.handoffId, typeof body.resumedFromStep === 'string' ? body.resumedFromStep : undefined); } catch (error) { warning = warning ?? (error instanceof Error ? error.message : String(error)); }
          broadcast('career:data-changed', { sessionId: sessionId(), tables: ['handoff', 'task', 'action_queue'] });
        }
        runs.transition(runId, 'running', { handoffId: undefined });
      }
      return ok({ run: runs.get(runId), ...(warning ? { warning } : {}) });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '接管失败', 409);
    }
  }

  return fail(`未知接口：POST ${pathname}`, 404);
}
