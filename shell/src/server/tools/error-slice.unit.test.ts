/**
 * 出错和误判切面：关键期一周里，AI 并不总是做对。
 * - 腾讯的面试邀请被读成了拒信，两天后用户发现，说「那是面试」——要能改回来，漏斗也不能多算一封拒信；
 * - 同一家网申页面连着打不开——不能无限重排，几次之后如实判失败；
 * - 对话里调浏览器时浏览器被占用——不是这份网申坏了，不能判死；
 * - 提交后不知道到底投出去没有——要落到「要你的事」里，不能只发一次审核事件就没了。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault, type Repos } from '@career/core';

import { BatchRunner } from '../career/batch-runner';
import { loadCore } from '../career/core-module';
import { captureIntake } from '../career/intake';
import { RunRegistry } from '../career/runs';
import { executeSubmitAction } from '../career/submit-executor';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

const NOW = '2026-10-20T02:00:00.000Z';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { isError: !!res.isError, text: res.content[0].text };
};

function approvedFill(repos: Repos, company: string) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: '后端开发', company_name: company, url: `https://${company}.example.com/apply` });
  const app = repos.createApplication(job.id);
  repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
  const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
  repos.reviewActions([action.id], 'approved');
  return { app, action: repos.getAction(action.id)! };
}

describe('出错和误判 · 关键期的一周', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let browser: (body: Record<string, unknown>, onEvent: (ev: Record<string, unknown>) => void) => Promise<void>;

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    browser = async () => undefined;
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 4))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: (body, onEvent) => browser(body, onEvent),
    });
  });

  async function misreadInterviewAsRejection() {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'tx', title: '后端开发', company_name: '腾讯' });
    const app = repos.createApplication(job.id);
    repos.jumpTo(app.id, 'applied', '已投递');
    llm.push(JSON.stringify({ kind: 'rejection', relevance: 'job', fields: { company: '腾讯' }, match: { application_id: app.id }, summary: '腾讯：很遗憾' }));
    await captureIntake({ repos, core: await loadCore(), llm, broadcast: () => undefined, sessionId: () => 'sess-1', now: () => NOW },
      { text: '很遗憾地通知你原定时间不合适，诚邀你改约 10月23日 15:00 的一面', source: 'mail' });
    expect(repos.getApplication(app.id)!.stage).toBe('rejected');
    return app.id;
  }

  it('面试邀请被读成拒信：用户说「那是面试」就能改回来，漏斗里不留那封并不存在的拒信', async () => {
    const appId = await misreadInterviewAsRejection();
    const res = await call('application_correct', { application_id: appId, stage: 'interview', note: '用户：那封是改约面试，不是拒信' });
    expect(res.isError).toBe(false);
    expect(repos.getApplication(appId)!.stage).toBe('interview');
    expect(repos.stageHistory().filter(h => h.application_id === appId).map(h => h.to_stage)).not.toContain('rejected');
    expect(repos.listDossierNotes(appId).map(n => n.content).join('\n')).toContain('更正');
  });

  it('改回来以后，再把那封邮件按面试归档，面试和期限都能建上', async () => {
    const appId = await misreadInterviewAsRejection();
    await call('application_correct', { application_id: appId, stage: 'applied', note: '先退回已投递' });
    llm.push(JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '腾讯', round: '一面', when: '10月23日 15:00' }, match: { application_id: appId }, summary: '腾讯一面' }));
    await captureIntake({ repos, core: await loadCore(), llm, broadcast: () => undefined, sessionId: () => 'sess-1', now: () => NOW },
      { text: '诚邀你参加 10月23日 15:00 的一面', source: 'mail', application_id: appId });
    expect(repos.getApplication(appId)!.stage).toBe('interview');
    expect(repos.listDeadlines({ application_id: appId }).length).toBeGreaterThan(0);
  });

  it('只撤刚才那一步：已经正常走过的阶段不动', async () => {
    const appId = await misreadInterviewAsRejection();
    await call('application_correct', { application_id: appId, stage: 'applied', note: '撤回误判' });
    expect(repos.stageHistory().filter(h => h.application_id === appId).map(h => h.to_stage)).toContain('applied');
  });

  it('同一家网申页面连着打不开：第 3 次如实判失败，不再无限重排', async () => {
    const { app, action } = approvedFill(repos, 'xunfei');
    const runner = new BatchRunner({
      repos, broadcast: () => undefined, control: () => 'agent',
      drive: async (_req, onEvent) => { const ev = { type: 'error', code: 'NAVIGATION_FAILED', error: '页面打不开' }; onEvent(ev); return [ev]; },
    });
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) kinds.push((await runner.runOne(repos.getAction(action.id)!, 'start')).kind);
    expect(kinds).toEqual(['transient', 'transient', 'failed']);
    expect(repos.getApplication(app.id)!.stage).toBe('blocked');
  });

  it('浏览器被别处占用不计次：占用多久都只是等，不会判死', async () => {
    const { action } = approvedFill(repos, 'meituan');
    const runner = new BatchRunner({
      repos, broadcast: () => undefined, control: () => 'agent',
      drive: async (_req, onEvent) => { const ev = { type: 'error', code: 'BROWSER_BUSY', error: '浏览器被占用' }; onEvent(ev); return [ev]; },
    });
    for (let i = 0; i < 5; i++) expect((await runner.runOne(repos.getAction(action.id)!, 'start')).kind).toBe('transient');
  });

  it('对话里调浏览器时被占用（抛错）：放回队列，不把这份网申打成阻塞', async () => {
    const { app, action } = approvedFill(repos, 'jd');
    browser = async () => { const e = new Error('浏览器正在被批量投递使用'); e.name = 'BROWSER_BUSY'; throw e; };
    const res = await call('apply_run', { action_id: action.id });
    expect(res.text).not.toContain('执行失败');
    expect(repos.getAction(action.id)!.status).toBe('approved');
    expect(repos.getApplication(app.id)!.stage).not.toBe('blocked');
  });

  it('提交后不确定投出去没有：落进「要你的事」，用户确认后才算', async () => {
    const { app, action } = approvedFill(repos, 'baidu');
    repos.setActionStatus(action.id, 'done');
    const submit = repos.enqueueAction('submit', { application_id: app.id, fill_action_id: action.id }, app.id);
    repos.reviewActions([submit.id], 'approved', 'user');
    await executeSubmitAction({ repos, broadcast: () => undefined, run: async (_b, on) => { const ev = { type: 'result', op: 'submit', result: { status: 'uncertain', message: '点了提交但页面没变化', edits: [] } }; on(ev); return [ev]; } }, submit.id);
    expect(repos.today(NOW).items.filter(i => i.kind === 'handoff').map(i => i.title).join()).toContain('提交');
  });

  it.todo('〔面〕网申判失败 / 放弃后，用户在哪里看到、要不要占等你条');
  it.todo('〔面〕拒信误判时用户怎么发现：现在拒信只计数、从不提醒');
  it.todo('〔组件〕风控锁接进真实投递链路（driveApplication 没传 riskGuard）');
});
