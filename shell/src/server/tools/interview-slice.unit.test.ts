/**
 * 面试切面：关键期的一周，同步、时间紧，一次只针对一家。
 * 周二 10:00 邮箱来了百度二面邀请（周四 14:00），随后又来一封「面试提醒」；当晚 21:00 说「帮我准备后天百度的面试」，
 * 预测追问、出题、连着模拟几轮；周五上午复盘；下周二还有字节同类岗位（机器学习算法）的二面。
 * 单位仍是「一份申请」：邀请、准备、复盘都要落在百度那份申请上，面完不能在今日队列里变成「已过期」。
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

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { loadCore } from '../career/core-module';
import { RunRegistry } from '../career/runs';
import { CareerStore } from '../career/store';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

/** 这条链路上用到的工具返回字段（只列测试读的）。 */
interface ToolResults {
  inbox_capture: { created: { application_id?: string } };
  today_queue: { items: Array<{ ref?: { id: string }; detail?: string; priority: number }> };
  dossier_get: { interviews: Array<{ id: string; round: string; retro_json: string | null }>; predictions: Array<{ statement: string }> };
  interview_predict: unknown;
  interview_probe: { mock_interview_id: string };
  interview_questions: { questions: Array<{ question_id: string }> };
  question_attempt: unknown;
  question_bank: { questions: Array<{ id: string; content: string; source: string; company: string | null; last_score: number | null }> };
  interview_retro: { interview_id: string };
}

async function call<K extends keyof ToolResults>(name: K, args: Record<string, unknown> = {}): Promise<ToolResults[K]> {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  if (res.isError) throw new Error(`${name} 报错：${res.content[0].text}`);
  const parsed: ToolResults[K] = JSON.parse(res.content[0].text);
  return parsed;
}

const TUE_MORNING = '2026-11-03T02:00:00.000Z'; // 周二 10:00（北京时间）
const TUE_NIGHT = '2026-11-03T13:00:00.000Z'; // 周二 21:00
const INTERVIEW_AT = '2026-11-05T14:00:00+08:00'; // 周四 14:00
const FRI_MORNING = '2026-11-06T01:30:00.000Z'; // 周五 09:30

const inviteTriage = (round = '二面', when = INTERVIEW_AT) => ({
  kind: 'interview_invite', relevance: 'job',
  fields: { company: '百度', title: '机器学习算法工程师', round, when, location_or_link: 'https://meeting.baidu.com/x' },
  summary: `百度 ${round}邀请`,
});
const invite = (round?: string, when?: string) => JSON.stringify(inviteTriage(round, when));

describe('面试 · 百度二面前一晚到下一场同类面试', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let baidu: { appId: string; jobId: string; tailoredId: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(TUE_MORNING));
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 5))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async () => undefined,
    });
    // 两周前投的百度，用的是定制版；一面已过
    const store = new CareerStore(repos, await loadCore());
    const master = store.createResumeMaster({ name: '主简历' });
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'bd-1', title: '机器学习算法工程师', company_name: '百度' });
    const tailored = store.createTailored({ master_id: master.id, job_id: job.id, schema_json: { basics: { name: '{{vault:name}}' }, work: [{ name: '美团', highlights: ['召回模型离线 AUC +1.8%'] }] } });
    const app = repos.createApplication(job.id, tailored.id);
    repos.jumpTo(app.id, 'interview', '一面通过');
    baidu = { appId: app.id, jobId: job.id, tailoredId: tailored.id };
  });
  afterEach(() => { vi.useRealTimers(); });

  /** 周二上午：邀请邮件进来，二十分钟后又来一封同一场的「面试提醒」。 */
  async function invitesArrive() {
    llm.push(invite());
    const first = await call('inbox_capture', { text: '【百度】机器学习算法工程师 二面邀请 11月5日14:00', source: 'paste' });
    llm.push(invite());
    await call('inbox_capture', { text: '【百度】面试提醒：您的二面将于11月5日14:00开始', source: 'paste' });
    return first;
  }

  it('邀请落在百度那份申请上：一场面试、一个时间点，重复的提醒不再多建一场', async () => {
    const first = await invitesArrive();
    expect(first.created.application_id).toBe(baidu.appId);
    const s = new CareerStore(repos, await loadCore());
    const itvs = s.listInterviews().filter(i => i.application_id === baidu.appId);
    expect(itvs).toHaveLength(1);
    expect(itvs[0]).toMatchObject({ round: 'second', date: new Date(INTERVIEW_AT).toISOString() });
    expect(repos.listDeadlines({ application_id: baidu.appId }).filter(d => d.kind === 'interview')).toHaveLength(1);
  });

  it('改期邮件把原来那个时间点挪过去，不留一个旧时间', async () => {
    await invitesArrive();
    llm.push(invite('二面', '2026-11-06T10:00:00+08:00'));
    await call('inbox_capture', { text: '【百度】二面时间调整为11月6日10:00', source: 'paste' });
    const ds = repos.listDeadlines({ application_id: baidu.appId }).filter(d => d.kind === 'interview');
    expect(ds.map(d => d.due_at)).toEqual([new Date('2026-11-06T10:00:00+08:00').toISOString()]);
  });

  it('周二今日队列里有这场面试，说的是「2 天后」而不是「截止」', async () => {
    await invitesArrive();
    const today = await call('today_queue');
    const item = today.items.find((i) => i.ref?.id === baidu.appId);
    expect(item?.detail).toContain('2 天后');
    expect(item?.detail).not.toContain('截止');
  });

  it('当晚「帮我准备」：按公司摊开卷宗，预测的深挖点挂在投出去的那版简历上', async () => {
    await invitesArrive();
    vi.setSystemTime(new Date(TUE_NIGHT));
    const before = await call('dossier_get', { company_name: '百度' });
    expect(before.interviews[0]).toMatchObject({ round: 'second' });
    llm.push(JSON.stringify({ predictions: [{ statement: '召回模型离线 AUC +1.8%', target_type: 'data', expected_chain: ['AUC 口径？', '线上收益？'], risk: 'high' }] }));
    // 用户只说了「百度的面试」，助理拿得到的是 job_id，不一定知道定制版的 id
    await call('interview_predict', { job_id: baidu.jobId, round: 'second' });
    const after = await call('dossier_get', { company_name: '百度' });
    expect(after.predictions.map((p) => p.statement)).toContain('召回模型离线 AUC +1.8%');
    // 预测要基于面试官手里那一版，而不是经历库的通用摘要
    expect(llm.calls.at(-1)?.messages[0].content).toContain('召回模型离线 AUC +1.8%');
  });

  it('当晚连着模拟几轮，记成一场模拟面试，不是每一问一条记录', async () => {
    await invitesArrive();
    vi.setSystemTime(new Date(TUE_NIGHT));
    llm.push(JSON.stringify({ question: '先介绍一下美团的召回项目' }));
    const open = await call('interview_probe', { job_id: baidu.jobId, round: 'second', company_type: '大厂' });
    llm.push(JSON.stringify({ question: 'AUC +1.8% 是怎么算的？' }));
    await call('interview_probe', { mock_interview_id: open.mock_interview_id, job_id: baidu.jobId, transcript: 'Q：介绍召回项目\nA：……' });
    llm.push(JSON.stringify({ verdict: 'borderline', diagnosis: [{ claim: 'AUC +1.8%', broke_at_layer: 2, issue: '说不清线上收益' }] }));
    const end = await call('interview_probe', { mock_interview_id: open.mock_interview_id, job_id: baidu.jobId, transcript: 'Q：介绍召回项目\nA：……\nQ：AUC 怎么算\nA：……', finish: true });
    expect(end.mock_interview_id).toBe(open.mock_interview_id);
    const s = new CareerStore(repos, await loadCore());
    const mocks = s.listMockInterviews();
    expect(mocks).toHaveLength(1);
    expect(mocks[0].report_json).toContain('borderline');
    expect(mocks[0].turns_json).toContain('AUC 怎么算');
  });

  it('当晚出的题进题库、绑定百度这个岗位，练过的分数记得住', async () => {
    llm.push(JSON.stringify({ questions: [{ type: 'project', question: '召回和排序的样本怎么构造？', probe_points: ['负样本'], difficulty: 'hard' }] }));
    const out = await call('interview_questions', { job_id: baidu.jobId, round: 'second' });
    const qid = out.questions[0].question_id as string;
    await call('question_attempt', { question_id: qid, answer_text: '……', score: 45, mode: 'mock', job_id: baidu.jobId });
    const bank = await call('question_bank', { job_id: baidu.jobId });
    expect(bank.questions[0]).toMatchObject({ id: qid, last_score: 45 });
  });

  /** 周五上午用户说「昨天百度二面复盘一下」，助理只知道公司和轮次。 */
  async function retroFriday() {
    await invitesArrive();
    vi.setSystemTime(new Date(FRI_MORNING));
    llm.push(JSON.stringify({ questions: [{ type: 'project', quote: '你们召回的负样本是怎么采的？', content_tags: ['content:负样本'], stuck_layer: 2 }], next_round_probes: ['线上 A/B 收益'], tags: ['content:负样本'] }));
    return call('interview_retro', { company_name: '百度', title: '机器学习算法工程师', round: 'second', transcript: '面试官问负样本……我答得不太好', date: '2026-11-05' });
  }

  it('复盘写回邀请建的那场面试，挂在百度申请上，不另起一条孤儿记录', async () => {
    const out = await retroFriday();
    const s = new CareerStore(repos, await loadCore());
    expect(s.listInterviews()).toHaveLength(1);
    const dossier = await call('dossier_get', { company_name: '百度' });
    expect(dossier.interviews[0].id).toBe(out.interview_id);
    expect(dossier.interviews[0].retro_json).toContain('线上 A/B 收益');
  });

  it('复盘过的面试不在周五的今日队列里顶成「已过期」', async () => {
    await retroFriday();
    const today = await call('today_queue');
    expect(today.items.filter((i) => i.ref?.id === baidu.appId && i.priority === 0)).toEqual([]);
    expect(repos.listDeadlines({ application_id: baidu.appId }).find(d => d.kind === 'interview')?.status).toBe('done');
  });

  it('复盘里被问到的原题进题库，下周准备字节同类岗位时按关键词查得到', async () => {
    await retroFriday();
    const bank = await call('question_bank', { q: '负样本' });
    expect(bank.questions[0]).toMatchObject({ content: '你们召回的负样本是怎么采的？', source: 'seen', company: '百度' });
  });

  it.todo('〔面〕面完还没复盘时（周四 14:00 之后），这场面试在今日队列里显示什么：「面完了吗，要复盘吗」还是不显示');
  it.todo('〔面〕下周字节同类二面：准备时要不要自动带上百度复盘的卡点（next_round_probes、低分题），「同类」按岗位类别还是按 JD 关键词判');
  it.todo('〔面〕复盘暴露的经历问题（说不清线上收益）回流到哪：给主张补事实的待确认卡、还是改简历措辞、还是只记在复盘里');
  it.todo('〔面〕面试前一晚的连续练习放在哪：对话里一问一答，还是一个专门的「模拟面试」工作面（计时、可中断续练）');
  it.todo('〔面〕「帮我准备」的终态是什么：一张百度二面准备卡（卷宗 + 深挖点 + 题 + 上一轮复盘）还是在对话里逐项给');
});
