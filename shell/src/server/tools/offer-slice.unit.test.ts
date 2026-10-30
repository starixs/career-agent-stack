/**
 * Offer 切面：十一月中，手里两个 Offer，期限交错、决定撤不回。
 * 林同学（硕士，算法方向）11 月 5 日收到小米意向书，7 日在对话里说「小米我接了」；
 * 10 日小米来信要求 17 日前签三方；14 日（周六）字节来了更想去的 Offer，21 日前答复。
 * 同时还在途：美团 18 日二面、百度 16 日测评。
 * 对象只有两三个，每个都重：同一家公司的来信要落在同一份申请、同一个 Offer 上；期限只能有一处真相；
 * 比较时助理要看得到每个 Offer 的处境（已接、三方截止），而不是一份过期的回复日期。
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

import { FakeLLM, StaticKeyProvider, Vault, type Offer } from '@career/core';

import { loadCore } from '../career/core-module';
import { captureIntake } from '../career/intake';
import { RunRegistry } from '../career/runs';
import { CareerStore } from '../career/store';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';
import type { OfferSituation } from './offer-tools';

const call = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  if (res.isError) throw new Error(`${name} 失败：${res.content[0].text}`);
  return JSON.parse(res.content[0].text) as T;
};

const triage = (company: string, title: string, due_at: string, notes: string, summary: string) =>
  JSON.stringify({ kind: 'offer', relevance: 'job', fields: { company, title, due_at, notes }, summary });

describe('Offer · 十一月中两个 Offer 期限交错', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let core: Awaited<ReturnType<typeof loadCore>>;

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    core = await loadCore();
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 5))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async () => undefined,
    });
  });

  /** 一封招聘邮件在 now 这一刻到达，走真实归档链路。 */
  const mailArrives = (now: string, triageJson: string, subject: string, text: string) => {
    llm.push(triageJson);
    return captureIntake({ repos, core, llm, broadcast: () => undefined, sessionId: () => 'global', now: () => now },
      { text, source: 'mail', mail: { subject, from: 'hr@company.com', received_at: now } });
  };

  const appsOf = (company: string) => repos.applicationsWithJob().filter(a => a.job.company_name === company);
  const offersOf = (company: string) => new CareerStore(repos, core).listOffers().filter(o => o.company_name === company);

  /** 11 月 14 日之前发生的事：小米意向 → 接受 → 三方通知；字节、美团、百度在途。 */
  async function untilNov14() {
    const bd = repos.createApplication(repos.upsertJob({ source_platform: 'manual', title: '推荐算法工程师', company_name: '字节跳动' }).id);
    repos.jumpTo(bd.id, 'interview', '三面通过');
    const mt = repos.createApplication(repos.upsertJob({ source_platform: 'manual', title: '算法工程师', company_name: '美团' }).id);
    repos.jumpTo(mt.id, 'interview', '一面通过');
    repos.createDeadline({ kind: 'interview', title: '美团 · 算法工程师 二面', due_at: '2026-11-18T06:00:00.000Z', application_id: mt.id });
    const bu = repos.createApplication(repos.upsertJob({ source_platform: 'manual', title: '机器学习工程师', company_name: '百度' }).id);
    repos.jumpTo(bu.id, 'applied', '已投');
    repos.createDeadline({ kind: 'assessment', title: '百度 · 机器学习工程师 测评', due_at: '2026-11-16T15:59:00.000Z', application_id: bu.id });

    await mailArrives('2026-11-05T02:00:00.000Z', triage('小米', '算法工程师', '11月8日', '录用意向书', '小米意向书，11 月 8 日前回复'), '【小米】录用意向书', '恭喜您……请于11月8日前回复是否接受');
    const xm = appsOf('小米')[0];
    await call('application_set_stage', { application_id: xm.id, stage: 'hired', note: '用户在对话里说接受小米意向' });
    await mailArrives('2026-11-10T02:00:00.000Z', triage('小米', '算法工程师', '2026-11-17', '三方签约', '小米请在 17 日前完成三方签约'), '【小米】三方协议签约通知', '请于2026-11-17前在学校就业系统完成三方签约');
    await mailArrives('2026-11-14T02:00:00.000Z', triage('字节跳动', '推荐算法工程师', '11月21日', '正式 Offer', '字节 Offer，21 日前答复'), '【字节跳动】Offer Letter', '请于11月21日前确认是否接受');
    return { xm: appsOf('小米')[0], bd };
  }

  it('接了小米以后，小米的「回复截止」不再挂在队列里，过了 8 号也不报「已过期」', async () => {
    await untilNov14();
    const items = repos.today('2026-11-09T02:00:00.000Z').items.map(i => i.title);
    expect(items.filter(t => t.includes('小米') && t.includes('回复'))).toEqual([]);
  });

  it('三方通知落在已接的那份小米申请上：不另建申请、不另建 Offer', async () => {
    const { xm } = await untilNov14();
    expect(appsOf('小米').map(a => a.id)).toEqual([xm.id]);
    expect(xm.stage).toBe('hired');
    expect(offersOf('小米')).toHaveLength(1);
  });

  it('三方截止记在 17 号当天结束前，标明是三方而不是 Offer 回复', async () => {
    const { xm } = await untilNov14();
    const open = repos.listDeadlines({ status: 'open', application_id: xm.id });
    expect(open.map(d => [d.title, d.due_at])).toEqual([['小米 · 算法工程师 三方签约截止', '2026-11-17T15:59:00.000Z']]);
  });

  it('14 号打开：三方三天后截止在队列里；字节 Offer 落在原来的面试申请上', async () => {
    const { bd } = await untilNov14();
    const titles = repos.today('2026-11-14T02:00:00.000Z').items.map(i => i.title);
    expect(titles).toContain('小米 · 算法工程师 三方签约截止');
    expect(repos.getApplication(bd.id)?.stage).toBe('offer');
    expect(appsOf('字节跳动')).toHaveLength(1);
  });

  it('问「小米和字节怎么选」：对话里列得出两个 Offer 和各自处境', async () => {
    await untilNov14();
    const { offers } = await call<{ offers: OfferSituation[] }>('offer_list');
    const byCo: Record<string, OfferSituation> = Object.fromEntries(offers.map(o => [o.company_name ?? '', o]));
    expect(byCo['小米'].stage).toBe('hired');
    expect(byCo['小米'].deadlines.map(d => d.title)).toEqual(['小米 · 算法工程师 三方签约截止']);
    expect(byCo['字节跳动'].stage).toBe('offer');
    expect(byCo['字节跳动'].deadlines.map(d => d.due_at)).toEqual(['2026-11-21T15:59:00.000Z']);
  });

  it('比较时喂给模型的是每个 Offer 的处境（已接、三方 17 号），不是过期的 8 号回复', async () => {
    await untilNov14();
    const ids = new CareerStore(repos, core).listOffers().map(o => o.id);
    llm.push(JSON.stringify({ offers: [], comparison_table: [], decide_yourself: [], ask_hr: [] }));
    await call('offer_compare', { offer_ids: ids });
    const prompt = String(llm.calls.at(-1)?.messages[0].content);
    expect(prompt).toContain('三方签约截止');
    expect(prompt).toContain('2026-11-17T15:59:00.000Z');
    expect(prompt).toContain('"stage": "hired"');
  });

  it('对话里补字节的薪酬和改答复期限：写进 Offer，截止事件跟着改，只有一处真相', async () => {
    await untilNov14();
    const bdOffer = offersOf('字节跳动')[0];
    const { offer } = await call<{ offer: Offer }>('offer_save', { offer_id: bdOffer.id, comp: { base: 32000, months: 15, signing: 30000 }, location: '北京', deadline: '2026-11-24' });
    expect(JSON.parse(offer.comp_json)).toEqual({ base: 32000, months: 15, signing: 30000 });
    const open = repos.listDeadlines({ status: 'open' }).filter(d => d.offer_id === bdOffer.id);
    expect(open.map(d => d.due_at)).toEqual(['2026-11-24T15:59:00.000Z']);
  });

  it('在 Offer 页手动新建、带答复日期：也进截止事件，月历和队列看得到', async () => {
    const offer = new CareerStore(repos, core).createOffer({ company_name: '快手', title: '算法工程师', deadline: '2026-11-20' });
    const open = repos.listDeadlines({ status: 'open' }).filter(d => d.offer_id === offer.id);
    expect(open.map(d => [d.kind, d.due_at])).toEqual([['offer_reply', '2026-11-20T15:59:00.000Z']]);
  });

  it('接了小米以后别家照常进行：美团二面、百度测评还在队列里，阶段一个没动（骑驴找马是正常的）', async () => {
    await untilNov14();
    const titles = repos.today('2026-11-15T02:00:00.000Z').items.map(i => i.title);
    expect(titles).toEqual(expect.arrayContaining(['美团 · 算法工程师 二面', '百度 · 机器学习工程师 测评']));
    expect(['美团', '百度'].map(c => appsOf(c)[0].stage)).toEqual(['interview', 'applied']);
  });

  it.todo('〔面〕两个撤不回的期限交错（小米三方 17 号早于字节答复 21 号）：要不要主动点出、给什么建议（向字节要提前答复 / 向小米申请延期），还是只在比较里列出');
  it.todo('〔面〕接了又反悔（意向毁约、三方违约）怎么记：现在 hired 是终点，记不下「接了又放弃」；放在 Offer 自己的状态还是投递阶段');
  it.todo('〔面〕没选的 Offer 要不要替用户起草婉拒信、什么时候发（对外、撤不回，必须用户批准）');
  it.todo('〔面〕比较的维度从用户画像来：投递、写简历时攒下的上下文推出他看重什么，比较时主动给针对性的信息（接本体建模）');
  it.todo('〔面〕Offer 页要不要分「已接 / 待答复 / 已放弃」、把最先到的撤不回期限放在最前');
});
