import { beforeEach, describe, expect, it, vi } from 'vitest';

// apply_run / apply_continue：按浏览器路由的 NDJSON 结果（progress / page / result / error）更新动作、任务、接管、阶段。
// 之前的实现等的是 type:'handoff' 事件（路由从不发），导致接管与报错都被记成"已填好"。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { RunRegistry } from '../career/runs';
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { ...res, text: res.content[0].text, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

type Ev = Record<string, unknown>;

describe('apply_run / apply_continue', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let events: Array<{ event: string; data: unknown }>;
  let script: Ev[];
  let bodies: Array<Record<string, unknown>>;
  let actionId: string;
  let applicationId: string;

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    events = []; script = []; bodies = [];
    const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 2)));
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    const runs = new RunRegistry((event, data) => events.push({ event, data }), () => 'sess-1');
    await createCareerServer({
      repos, vault, llm: new FakeLLM(), runs, broadcast: (event, data) => events.push({ event, data }), sessionId: () => 'sess-1',
      resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async (body, onEvent) => { bodies.push(body); for (const ev of script) onEvent(ev); },
    });
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法实习生', company_name: 'B 公司', url: 'https://x.com/apply' });
    const app = repos.createApplication(job.id);
    repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
    applicationId = app.id;
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    actionId = action.id;
  });

  it('停在提交前：submit 进待审队列，动作 done，返回脱敏摘要', async () => {
    script = [
      { type: 'progress', phase: 'drive', message: '第 1 页：3 个字段' },
      { type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: '已停在提交按钮前', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '提交', filled: [{ label: '手机号', value: '{{vault:profile.phone}}' }], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } },
    ];
    const res = await call('apply_run', { action_id: actionId });
    expect(res.isError).toBeUndefined();
    const out = res.json() as { state: string; submitActionId: string; summary: { filled: Array<{ value: string }> } };
    expect(out.state).toBe('done');
    expect(bodies[0]).toMatchObject({ op: 'drive', url: 'https://x.com/apply', applicationId });
    expect(repos.getAction(actionId)!.status).toBe('done');
    expect(repos.getAction(out.submitActionId)).toMatchObject({ kind: 'submit', status: 'pending_review', application_id: applicationId });
    expect(repos.getApplication(applicationId)!.next_action).toBe('审核后提交');
    expect(events.some(e => e.event === 'career:review')).toBe(true);
    expect(res.text).not.toContain('13800138000');
  });

  it('接管（result.status=handoff）：开 handoff、动作 needs_user、run 暂停；apply_continue 从当前页继续且不传 url', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'captcha', captchaKind: 'slider', message: '需要你本人处理：captcha', userAction: '请拖动滑块完成验证', finalUrl: 'https://x.com/apply', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    const res = await call('apply_run', { action_id: actionId });
    const out = res.json() as { state: string; handoffId: string; userAction: string };
    expect(out.state).toBe('paused'); expect(out.userAction).toContain('滑块');
    expect(repos.getAction(actionId)!.status).toBe('needs_user');
    expect(repos.openHandoffs()).toHaveLength(1);
    expect(repos.getApplication(applicationId)!.stage).toBe('needs_user');
    const takeover = events.filter(e => e.event === 'career:takeover').map(e => e.data as { state: string });
    expect(takeover.at(-1)?.state).toBe('paused');
    // 再 apply_run 会被拒；apply_continue 可以
    expect((await call('apply_run', { action_id: actionId })).isError).toBe(true);
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    const cont = await call('apply_continue', { action_id: actionId });
    expect(cont.isError).toBeUndefined();
    expect(bodies[1].url).toBeUndefined();
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(repos.getAction(actionId)!.status).toBe('done');
    expect(repos.listTasks().filter(t => t.kind === 'apply')).toHaveLength(1); // 复用同一个任务
  });

  it('路由报错行（如 501 引擎未就绪）→ 动作 failed、投递 blocked，不再记成已填好', async () => {
    script = [{ type: 'error', status: 501, error: '表单引擎 @career/apply 尚未构建' }];
    const res = await call('apply_run', { action_id: actionId });
    expect(res.isError).toBe(true); expect(res.text).toContain('501');
    expect(repos.getAction(actionId)!.status).toBe('failed');
    expect(repos.getApplication(applicationId)!.stage).toBe('blocked');
    expect(repos.listActions('pending_review')).toHaveLength(0);
  });

  it('blocked 结果（风控锁）→ 投递 blocked 并带原因', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'blocked', message: '平台限流提示：访问过于频繁，已上风险锁', finalUrl: 'https://x.com/apply', adapterId: 'boss', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    const res = await call('apply_run', { action_id: actionId });
    expect(res.isError).toBe(true); expect(res.text).toContain('被阻塞');
    expect(repos.getApplication(applicationId)!.blocker_reason).toContain('限流');
  });
});
