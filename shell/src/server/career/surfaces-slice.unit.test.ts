/**
 * 对话和页面分工切面：情景 C「两天没开，回来」（世界模型 §7.1）。
 * 关键期，周三晚上最后一次打开，周五 18:00 回来。期间来了 1 个面试邀请（百度，后天）、2 个笔试 / 测评
 * （九方云测评今晚 23:59 截止、讯飞笔试下周一）、2 封拒信（拼多多、京东），其余 13 家没有回音；
 * 走之前记过的美团笔试（周四晚）他在牛客上考完了，没回软件打勾。
 *
 * 他先在通知中心把今晚的测评做掉，再去招聘概览的月历看后天的面试（顺手让小芽改个时间），最后回到对话问「还有啥」。
 * 同一件事在今日队列、通知中心、月历、助力记录、对话里必须是同一个对象：一处处理完，别处不能还挂着。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault, type Repos } from '@career/core';

import { handleCareerRoute } from '../routes/career';
import { createCareerServer } from '../tools/career-tools';
import { loadCore } from './core-module';
import { captureIntake } from './intake';
import { RunRegistry } from './runs';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

/** 周五 18:00（北京时间）。 */
const NOW = '2026-10-30T10:00:00.000Z';
const LEFT_AT = '2026-10-28T13:00:00.000Z';
const SILENT = ['美团', '腾讯', '阿里巴巴', '字节跳动', '网易', '小红书', '快手', '滴滴', '携程', '米哈游', '哔哩哔哩', '蔚来', '理想'];
const REPLIED = ['九方云', '讯飞', '百度', '拼多多', '京东'];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { isError: !!res.isError, json: JSON.parse(res.content[0].text) as Record<string, unknown> };
};

async function page(repos: Repos, method: string, path: string, body?: unknown) {
  const request = new Request(`http://local${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  const res = await handleCareerRoute(new URL(request.url).pathname, request, { repos, broadcast: () => undefined, sessionId: () => 'global', llm: null });
  if (!res) throw new Error(`没有这个页面接口：${method} ${path}`);
  return await res.json() as Record<string, unknown>;
}

describe('对话和页面分工 · 两天没开，回来', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  const appOf = (company: string) => repos.applicationsWithJob().find(a => a.job.company_name === company)!;
  const deadlineOf = (company: string, kind: string) => repos.listDeadlines({ application_id: appOf(company).id }).find(d => d.kind === kind)!;

  /** 周三之前：18 家已投出；美团笔试周四 19:00。 */
  function beforeLeaving() {
    vi.setSystemTime(new Date('2026-10-26T02:00:00.000Z'));
    for (const company of [...SILENT, ...REPLIED]) {
      const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: '后端开发', company_name: company });
      repos.jumpTo(repos.createApplication(job.id).id, 'applied', '已投递');
    }
    repos.createDeadline({ kind: 'written_test', title: '美团 · 后端开发 笔试', due_at: '2026-10-29T11:00:00.000Z', application_id: appOf('美团').id, source: 'mail' });
    vi.setSystemTime(new Date(LEFT_AT));
  }

  /** 不在的两天里邮箱同步进来的五封信。 */
  async function mailWhileAway() {
    const core = await loadCore();
    const mails: Array<[string, Record<string, unknown>]> = [
      ['2026-10-29T02:00:00.000Z', { kind: 'assessment', relevance: 'job', fields: { company: '九方云', title: '后端开发', due_at: '2026-10-30T23:59:00+08:00' }, summary: '九方云在线测评，今晚截止' }],
      ['2026-10-29T03:00:00.000Z', { kind: 'written_test', relevance: 'job', fields: { company: '讯飞', title: '后端开发', when: '2026-11-02T19:00:00+08:00' }, summary: '讯飞笔试下周一' }],
      ['2026-10-29T06:00:00.000Z', { kind: 'interview_invite', relevance: 'job', fields: { company: '百度', title: '后端开发', round: '一面', when: '2026-11-01T14:00:00+08:00' }, summary: '百度一面周日' }],
      ['2026-10-29T08:00:00.000Z', { kind: 'rejection', relevance: 'job', fields: { company: '拼多多' }, summary: '拼多多：很遗憾' }],
      ['2026-10-30T01:00:00.000Z', { kind: 'rejection', relevance: 'job', fields: { company: '京东' }, summary: '京东：很遗憾' }],
    ];
    for (const [at, triage] of mails) {
      vi.setSystemTime(new Date(at));
      llm.push(JSON.stringify(triage));
      await captureIntake({ repos, core, llm, broadcast: () => undefined, sessionId: () => 'global', now: () => at }, { text: String(triage.summary), source: 'mail' });
    }
    vi.setSystemTime(new Date(NOW));
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7))), llm, broadcast, sessionId: () => 'global',
      runs: new RunRegistry(broadcast, () => 'global'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
    });
    beforeLeaving();
    await mailWhileAway();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('回来时今日队列的第一件是今晚截止的测评，不是周四已经考完的笔试', () => {
    const first = repos.today(NOW).items[0];
    expect(first.title).toContain('九方云');
    expect(first.deadline_id).toBe(deadlineOf('九方云', 'assessment').id);
  });

  it('周四考完没打勾的美团笔试：不当「已过期」催，问一句「考了吗」；在月历上答了，各处都收起、卷宗记一笔', async () => {
    const exam = deadlineOf('美团', 'written_test');
    expect(repos.today(NOW).items.find(i => i.deadline_id === exam.id)).toMatchObject({ title: '美团 · 后端开发 笔试：考了吗？', ask: 'attendance' });
    const calendar = (await page(repos, 'GET', '/api/career/deadlines')).deadlines as Array<{ id: string; attendance_question: string | null }>;
    expect(calendar.find(d => d.id === exam.id)?.attendance_question).toBe('考了吗？');

    await page(repos, 'POST', `/api/career/deadlines/${exam.id}/attendance`, { attended: true });

    expect(repos.today(NOW).items.map(i => i.deadline_id)).not.toContain(exam.id);
    const reminders = (await page(repos, 'GET', '/api/career/deadlines?status=open_or_missed')).deadlines as Array<{ id: string }>;
    expect(reminders.map(d => d.id)).not.toContain(exam.id);
    expect(repos.listDossierNotes(appOf('美团').id).map(n => n.content)).toContain('美团 · 后端开发 笔试：参加了（回来时确认）');
  });

  it('在对话里说「美团那个没去」：小芽记成没去，漏斗照样把那封笔试邀请算作回应', async () => {
    const exam = deadlineOf('美团', 'written_test');
    const responded = () => repos.monthBoard({ nowIso: NOW, month: '2026-10' }).counts[1];
    const before = responded();
    const res = await call('deadline_done', { deadline_id: exam.id, status: 'skipped' });
    expect(res.json.deadline).toMatchObject({ status: 'skipped' });
    expect(repos.listDossierNotes(appOf('美团').id).map(n => n.content).join()).toContain('没参加');
    expect(responded()).toBe(before);
  });

  it('拒信只计数、不逐条进队列；其余投递只给等待数', () => {
    const today = repos.today(NOW);
    expect(today.items.map(i => i.title).join()).not.toMatch(/拼多多|京东/);
    expect(today.waiting.count).toBe(SILENT.length + 3);
  });

  it('在通知中心点「完成」：今日队列、月历、通知中心的提醒都用同一个 id，一处完成处处消失', async () => {
    const assessment = deadlineOf('九方云', 'assessment');
    const reminders = (await page(repos, 'GET', '/api/career/deadlines?status=open_or_missed')).deadlines as Array<{ id: string }>;
    expect(reminders.map(d => d.id)).toContain(assessment.id);

    await page(repos, 'POST', `/api/career/deadlines/${assessment.id}/status`, { status: 'done' });

    expect(repos.today(NOW).items.map(i => i.deadline_id)).not.toContain(assessment.id);
    const stillReminded = (await page(repos, 'GET', '/api/career/deadlines?status=open_or_missed')).deadlines as Array<{ id: string }>;
    expect(stillReminded.map(d => d.id)).not.toContain(assessment.id);
    const calendar = (await page(repos, 'GET', '/api/career/deadlines')).deadlines as Array<{ id: string; status: string }>;
    expect(calendar.find(d => d.id === assessment.id)?.status).toBe('done');
  });

  it('在月历上让小芽把百度一面改到周日上午：助力记录里的面试时间跟着变', async () => {
    const itvDeadline = deadlineOf('百度', 'interview');
    const res = await call('deadline_update', { deadline_id: itvDeadline.id, due_at: '2026-11-01T10:00:00+08:00' });
    expect(res.isError).toBe(false);
    const itv = new CareerStore(repos, await loadCore()).getInterview(itvDeadline.interview_id!);
    expect(itv?.date).toBe('2026-11-01T02:00:00.000Z');
  });

  it('在助力记录里改面试时间：月历上的那个时间点也跟着变', async () => {
    const itvDeadline = deadlineOf('百度', 'interview');
    await page(repos, 'PUT', `/api/career/interviews/${itvDeadline.interview_id}`, { date: '2026-11-01T02:00:00.000Z' });
    expect(repos.getDeadline(itvDeadline.id)?.due_at).toBe('2026-11-01T02:00:00.000Z');
  });

  it('回到对话问「还有啥」：小芽拿到的队列里已经没有做完的测评，最急的是后天的面试', async () => {
    const assessment = deadlineOf('九方云', 'assessment');
    await page(repos, 'POST', `/api/career/deadlines/${assessment.id}/status`, { status: 'done' });
    const queue = (await call('today_queue')).json as { items: Array<{ title: string; deadline_id?: string }> };
    expect(queue.items.map(i => i.deadline_id)).not.toContain(assessment.id);
    expect(queue.items[0].title).toContain('百度');
  });

  it('一封没认出来的信进了队列：条目指向那封信本身，月历和小芽面板点「去通知中心」能定位过去', async () => {
    const junk = repos.createInboxItem({ source: 'mail', raw_text: '您有一条新的通知，请登录查看' });
    const item = repos.today(NOW).items.find(i => i.kind === 'inbox')!;
    // 页面只认 inbox_item（CareerToday「去通知中心」、CompanionPanel），和 inbox_item.linked_type 同一套叫法
    expect(item.ref).toEqual({ type: 'inbox_item', id: junk.id });
  });

  it.todo('〔面〕通知中心里处理完的邮件（已归档、关联的时间点也做完）还要不要留在「全部」的计数里');
  it.todo('〔组件〕回来卡（等你条之后做）：读同一份今日队列，页面上刚处理掉的不进卡');
});
