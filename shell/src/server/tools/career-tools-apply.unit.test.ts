import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
import { packetKvKey } from '../career/packet-prepare';
import { RunRegistry } from '../career/runs';
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}, toolUseId?: string) => {
  const h = mocks.handlers.get(name) as ((a: Record<string, unknown>, extra?: unknown) => ReturnType<Handler>) | undefined;
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args, toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : undefined);
  return { ...res, text: res.content[0].text, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

type Ev = Record<string, unknown>;
const PASSING_REVIEW = { rows: [{ label: '手机号', required: true, status: 'ok' }], attention: 0, requiredTotal: 1, requiredFilled: 1, formSignature: 'sig', openAnswersHash: 'h' };
const cardsOf = (events: Array<{ event: string; data: unknown }>, kind: string) => events.filter(e => e.event === 'career:card').map(e => (e.data as { card: { id: string; kind: string; title: string; toolUseId: string | null; data: Record<string, unknown> } }).card).filter(c => c.kind === kind);

describe('apply_run / apply_continue', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let events: Array<{ event: string; data: unknown }>;
  let script: Ev[];
  let bodies: Array<Record<string, unknown>>;
  let actionId: string;
  let applicationId: string;
  let jobId: string;
  let duringRun: Array<() => void>;

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    events = []; script = []; bodies = []; duringRun = [];
    const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 2)));
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    const runs = new RunRegistry((event, data) => events.push({ event, data }), () => 'sess-1');
    await createCareerServer({
      repos, vault, llm: new FakeLLM(), runs, broadcast: (event, data) => events.push({ event, data }), sessionId: () => 'sess-1',
      resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async (body, onEvent) => { bodies.push(body); for (const f of duringRun) f(); for (const ev of script) onEvent(ev); },
    });
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法实习生', company_name: 'B 公司', url: 'https://x.com/apply' });
    const app = repos.createApplication(job.id);
    repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
    applicationId = app.id;
    jobId = job.id;
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    actionId = action.id;
  });

  it('停在提交前：submit 进待审队列，动作 done，返回脱敏摘要', async () => {
    script = [
      { type: 'progress', phase: 'drive', message: '第 1 页：3 个字段' },
      { type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: '已停在提交按钮前', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '提交', filled: [{ label: '手机号', value: '{{vault:profile.phone}}' }], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: PASSING_REVIEW } },
    ];
    const res = await call('apply_run', { action_id: actionId }, 'toolu_run');
    expect(res.isError).toBeUndefined();
    const out = res.json() as { state: string; submitActionId: string; summary: { filled: Array<{ value: string }> } };
    expect(out.state).toBe('done');
    expect(bodies[0]).toMatchObject({ op: 'drive', url: 'https://x.com/apply', applicationId });
    expect(repos.getAction(actionId)!.status).toBe('done');
    expect(repos.getAction(out.submitActionId)).toMatchObject({ kind: 'submit', status: 'pending_review', application_id: applicationId });
    expect(repos.getApplication(applicationId)!.next_action).toBe('审核后提交');
    // 提交卡：挂在这次工具调用下面，文案按实际数字生成；给模型的说明也按数字，不写死"表单已填好"
    const [submitCard] = cardsOf(events, 'review');
    expect(submitCard).toMatchObject({ id: `review:${out.submitActionId}`, toolUseId: 'toolu_run', title: '「B 公司 算法实习生」必填 1/1 已填好并核对过，停在「提交」前' });
    expect(repos.getChatCard(submitCard.id)!.tool_use_id).toBe('toolu_run');
    expect(res.json().note).toContain('必填 1/1 已填好并核对过');
    expect(res.text).not.toContain('表单已填好');
    expect(res.text).not.toContain('13800138000');
    expect(events.filter(e => e.event === 'career:progress').map(e => (e.data as { phase: string }).phase)).not.toContain('apply_run');
  });

  it('接管（result.status=handoff）：开 handoff、动作 needs_user、run 暂停；apply_continue 从当前页继续且不传 url', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'captcha', captchaKind: 'slider', message: '需要你本人处理：验证码', userAction: '请拖动滑块完成验证', finalUrl: 'https://x.com/apply', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
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
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: PASSING_REVIEW } }];
    const cont = await call('apply_continue', { action_id: actionId });
    expect(cont.isError).toBeUndefined();
    expect(bodies[1].url).toBeUndefined();
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(repos.getAction(actionId)!.status).toBe('done');
    expect(repos.listTasks().filter(t => t.kind === 'apply')).toHaveLength(1); // 复用同一个任务
  });

  it('交还后接着填：用运行器冻结的材料包，提交绑同一份', async () => {
    const pdf = join(mkdtempSync(join(tmpdir(), 'career-apply-continue-')), 'frozen.pdf');
    writeFileSync(pdf, '%PDF frozen');
    const sha = createHash('sha256').update('%PDF frozen').digest('hex');
    const packet = repos.createPacket({ application_id: applicationId, job_id: jobId, resume_id: null, resume_kind: 'tailored', resume_schema_json: null, resume_pdf_path: pdf, resume_pdf_sha256: sha, answers: {} });
    // 运行器开跑前冻结：记在 kv，不进 payload（改 payload 会让批准失效）
    repos.kvSet(packetKvKey(actionId), packet.id);
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'captcha', captchaKind: 'slider', message: '需要你本人处理：验证码', userAction: '请拖动滑块完成验证', finalUrl: 'https://x.com/apply', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    await call('apply_run', { action_id: actionId });
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '提交', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: PASSING_REVIEW } }];
    const cont = await call('apply_continue', { action_id: actionId });
    expect(cont.isError).toBeUndefined();
    expect(String(bodies[1].resumePath)).toContain(packet.id);
    const submit = repos.listActions().find(a => a.kind === 'submit')!;
    expect(JSON.parse(submit.payload_json)).toMatchObject({ packet_id: packet.id, resumeSha: sha });
  });

  it('还在等他登录：apply_continue 不继续，也不让小芽说「登录好了」；他交还 / 登录被认出来之后才继续', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'login', message: '需要你本人处理：登录', userAction: '请登录', finalUrl: 'https://x.zhiye.com/login', adapterId: 'beisen', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    await call('apply_run', { action_id: actionId });
    const early = await call('apply_continue', { action_id: actionId });
    expect(early.json()).toMatchObject({ continued: false, waiting_for: 'login' });
    expect(bodies).toHaveLength(1);
    repos.closeHandoff(repos.openHandoffs()[0].id, 'login_detected');
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.zhiye.com/apply', adapterId: 'beisen', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: PASSING_REVIEW } }];
    expect((await call('apply_continue', { action_id: actionId })).isError).toBeUndefined();
    expect(bodies).toHaveLength(2);
  });

  it('路由报错行（如 501 引擎未就绪）是瞬时问题 → 放回队列等重试，不判 failed、不 blocked', async () => {
    script = [{ type: 'error', status: 501, error: '表单引擎 @career/apply 尚未构建' }];
    const res = await call('apply_run', { action_id: actionId });
    expect(res.isError).toBe(true); expect(res.text).toContain('apply_run'); expect(res.text).toContain('重试');
    expect(repos.getAction(actionId)!.status).toBe('approved'); // 放回队列：原批准仍有效
    expect(repos.getApplication(applicationId)!.stage).not.toBe('blocked');
    expect(repos.listActions('pending_review')).toHaveLength(0);
  });

  it('用户接管期间提前调 apply_continue（409 BROWSER_CONTROL_HUMAN）→ 不是失败，等交回后可继续', async () => {
    // 第一步：正常跑到验证码接管（动作 needs_user）
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'captcha', userAction: '请完成验证码', message: '验证码', finalUrl: 'https://x.com/apply', adapterId: 'x', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    await call('apply_run', { action_id: actionId });
    expect(repos.getAction(actionId)!.status).toBe('needs_user');
    // 第二步：用户还没点"交回"，助理就被催着继续 → 路由 409 BROWSER_CONTROL_HUMAN
    script = [{ type: 'error', status: 409, code: 'BROWSER_CONTROL_HUMAN', error: '用户正在接管浏览器' }];
    const cont = await call('apply_continue', { action_id: actionId });
    expect(cont.isError).toBe(true); expect(cont.text).toContain('交回');
    expect(repos.getAction(actionId)!.status).toBe('needs_user'); // 没被打死：交回后 apply_continue 仍可用
  });

  it('blocked 结果（风控锁）→ 投递 blocked 并带原因', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'blocked', message: '平台限流提示：访问过于频繁，已上风险锁', finalUrl: 'https://x.com/apply', adapterId: 'boss', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    const res = await call('apply_run', { action_id: actionId });
    expect(res.isError).toBe(true); expect(res.text).toContain('被阻塞');
    expect(repos.getApplication(applicationId)!.blocker_reason).toContain('限流');
  });

  it('停在提交前但没过门槛：不入队提交，推"还差 N 项"卡片；补完 apply_continue 重新检查通过后才出提交卡', async () => {
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '投递', filled: [], needsUser: [{ label: '期望薪资', note: '答案库里没有' }], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'],
      review: { rows: [{ label: '手机号', required: true, status: 'ok' }, { label: '期望薪资', required: true, status: 'needs_user' }, { label: '毕业时间', required: true, status: 'empty', reason: '必填项还是空的' }], attention: 2, requiredTotal: 3, requiredFilled: 1 } } }];
    const res = await call('apply_run', { action_id: actionId }, 'toolu_run');
    const out = res.json() as { state: string; requiredFilled: number; requiredTotal: number; note: string };
    expect(out).toMatchObject({ state: 'needs_user', requiredFilled: 1, requiredTotal: 3 });
    expect(out.note).toContain('还差 2 项要你补');
    expect(res.text).not.toContain('表单已填好');
    expect(repos.listActions().filter(a => a.kind === 'submit')).toHaveLength(0);
    expect(cardsOf(events, 'review')).toHaveLength(0);
    const [gaps] = cardsOf(events, 'apply_gaps');
    expect(gaps).toMatchObject({ id: `apply_gaps:${actionId}`, toolUseId: 'toolu_run', title: '「B 公司 算法实习生」还差 2 项要你补：期望薪资、毕业时间' });
    expect((gaps.data.items as Array<{ label: string; reason: string }>).map(i => i.label)).toEqual(['期望薪资', '毕业时间']);
    expect(repos.getAction(actionId)!.status).toBe('needs_user');
    expect(repos.openHandoffs().map(h => h.reason)).toEqual(['missing_info']);

    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '投递', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: { ...PASSING_REVIEW, rows: [{ label: 'a', required: true, status: 'ok' }, { label: 'b', required: true, status: 'ok' }, { label: 'c', required: true, status: 'ok' }], requiredTotal: 3, requiredFilled: 3 } } }];
    const cont = await call('apply_continue', { action_id: actionId }, 'toolu_cont');
    expect(cont.json().state).toBe('done');
    expect(repos.getChatCard(`apply_gaps:${actionId}`)!.state).toBe('completed');
    expect(cardsOf(events, 'review').at(-1)).toMatchObject({ toolUseId: 'toolu_cont', title: '「B 公司 算法实习生」必填 3/3 已填好并核对过，停在「投递」前' });
  });

  it('apply_prepare：冻结材料包后直接开始填（不弹填表审批卡、不进待审），后台批量看不到这份', async () => {
    const { BatchRunner } = await import('../career/batch-runner');
    let batchQueueDuringRun = -1;
    let statusDuringRun = '';
    duringRun.push(() => {
      const peek = new BatchRunner({ repos, drive: async () => [], control: () => 'agent', broadcast: () => {} });
      batchQueueDuringRun = peek.queue().length;
      statusDuringRun = repos.listActions().find(a => a.kind === 'fill_form' && a.id !== actionId)?.status ?? '';
    });
    script = [{ type: 'result', op: 'drive', result: { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', submitButton: '提交', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], review: PASSING_REVIEW } }];
    // beforeEach 里那份已批准的动作不算：只看 apply_prepare 新建的
    repos.setActionStatus(actionId, 'rejected');
    const res = await call('apply_prepare', { job_id: jobId }, 'toolu_prep');
    expect(res.isError).toBeUndefined();
    const out = res.json() as { action_id: string; state: string; submitActionId: string };
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ op: 'drive', url: 'https://x.com/apply', actionId: out.action_id });
    expect(statusDuringRun).toBe('executing');
    expect(batchQueueDuringRun).toBe(0);
    const fill = repos.getAction(out.action_id)!;
    expect(fill).toMatchObject({ kind: 'fill_form', status: 'done', approved_by: 'system' });
    expect(repos.listActions('pending_review').filter(a => a.kind === 'fill_form')).toHaveLength(0);
    // 只有提交前那一张审核卡，没有"待审核 · 填表"
    const reviews = cardsOf(events, 'review');
    expect(reviews.map(c => c.data.kind)).toEqual(['submit']);
    expect(reviews[0].toolUseId).toBe('toolu_prep');
    expect(out.state).toBe('done');
    // 今日队列里也不会出现"待你批准：网申填表"
    expect(repos.today().items.some(i => i.title.includes('网申填表'))).toBe(false);
  });
});
