/**
 * 投出之后切面（立场 9：和 AI 协作本身不能成为新的劳动）。
 * 关键期的一周：美团投了两个岗位（后端开发、算法），百度投了一个。
 *  - 周一 美团来信「面试邀请」没写岗位 → 不能另建一份「未命名岗位」；先不归档，助理自己对、对不上再一句话问。
 *  - 今日队列里这场面试带「帮我准备」，点一下就开始；按公司准备时自动挑排着面试的那份。
 *  - 百度的面试邀请被读成了拒信 → 他说一句「那封是面试」（inbox_correct）：漏斗不留那封拒信，面试时间重抽、时间点建上，不追问。
 *  - 一封培训广告被读成笔试 → 说一句「那是广告」：时间点撤掉，信进已忽略。
 *  - 过了时间的面试不问「去了吗」，走复盘。
 * 边角情况不加按钮（10-30 用户定：界面保持克制），只保证一句话就办完、不追问。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), descriptions: new Map<string, string>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); mocks.descriptions.set(name, description); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { loadCore } from '../career/core-module';
import { correctIntake } from '../career/intake-fix';
import { runInterviewRetro } from '../career/interview-retro-run';
import type { IntakeDeps } from '../career/intake';
import { RunRegistry } from '../career/runs';
import { CareerStore } from '../career/store';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

interface ToolResults {
  inbox_capture: { item_id: string; status: string; created: { application_id?: string }; candidates: Array<{ application_id: string; label: string }>; note: string };
  today_queue: { items: Array<{ kind: string; title: string; suggest?: string; ask?: string; ref: { id: string } }> };
  interview_prep: { application_id: string };
  interview_book: { application_id: string; interview_id: string; deadline_id: string };
}

async function call<K extends keyof ToolResults>(name: K, args: Record<string, unknown> = {}): Promise<ToolResults[K]> {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  if (res.isError) throw new Error(`${name} 报错：${res.content[0].text}`);
  const parsed: ToolResults[K] = JSON.parse(res.content[0].text);
  return parsed;
}

const MON = '2026-11-02T02:00:00.000Z'; // 周一 10:00（北京时间）
const INTERVIEW_AT = '2026-11-04T14:00:00+08:00'; // 周三 14:00
const triage = (kind: string, fields: Record<string, string>, summary = '') => JSON.stringify({ kind, relevance: 'job', fields, summary });

describe('投出之后 · 回音进来到复盘，用户不用打字解释', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let deps: IntakeDeps;
  let cards: Array<{ kind: string; data: Record<string, unknown> }>;
  let mt: { backend: string; algo: string };
  let baidu: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(MON));
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    cards = [];
    const broadcast = (event: string, data: unknown) => {
      const card = (data as { card?: { kind: string; data: Record<string, unknown> } }).card;
      if (event === 'career:card' && card) cards.push(card);
    };
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async () => undefined,
    });
    deps = { repos, core: await loadCore(), llm, broadcast, sessionId: () => 'sess-1' };
    const sent = (company: string, title: string) => {
      const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `${company}-${title}`, title, company_name: company });
      const app = repos.createApplication(job.id, null);
      repos.jumpTo(app.id, 'applied', '投出');
      return app.id;
    };
    mt = { backend: sent('美团', '后端开发工程师'), algo: sent('美团', '算法工程师') };
    baidu = sent('百度', '机器学习算法工程师');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('同一家两份在投、信里没写岗位：不另建一份「未命名岗位」，先不归档；定下是哪份后带 application_id 落到那份上', async () => {
    llm.push(triage('interview_invite', { company: '美团', round: '一面', when: INTERVIEW_AT }, '美团一面邀请'));
    const before = repos.listApplications().length;
    const out = await call('inbox_capture', { text: '【美团】诚邀您参加一面，11月4日14:00，腾讯会议', source: 'mail' });

    expect(repos.listApplications()).toHaveLength(before);
    expect(out.status).toBe('new');
    expect(out.candidates.map(c => c.application_id).sort()).toEqual([mt.backend, mt.algo].sort());
    expect(cards.some(c => c.kind === 'pick_application')).toBe(false); // 边角情况不往对话里插卡
    expect(out.note).not.toMatch(/请问用户|解释/);

    llm.push(triage('interview_invite', { company: '美团', round: '一面', when: INTERVIEW_AT }));
    await call('inbox_capture', { text: '【美团】诚邀您参加一面，11月4日14:00，腾讯会议', source: 'mail', application_id: mt.algo });
    expect(repos.getApplication(mt.algo)?.stage).toBe('interview');
    expect(repos.getApplication(mt.backend)?.stage).toBe('applied');
  });

  it('信里写了岗位就自己对上，不问', async () => {
    llm.push(triage('interview_invite', { company: '美团', title: '后端开发工程师', round: '一面', when: INTERVIEW_AT }));
    const out = await call('inbox_capture', { text: '【美团】后端开发工程师 一面邀请', source: 'mail' });
    expect(out.created.application_id).toBe(mt.backend);
    expect(out.candidates).toEqual([]);
  });

  it('今日队列里两天后的面试带「帮我准备」；按公司准备时自动挑排着面试的那份', async () => {
    llm.push(triage('interview_invite', { company: '美团', title: '算法工程师', round: '一面', when: INTERVIEW_AT }));
    await call('inbox_capture', { text: '【美团】算法工程师 一面邀请', source: 'mail' });
    const item = (await call('today_queue')).items.find(i => i.ref.id === mt.algo);
    expect(item?.suggest).toBe('帮我准备美团 · 算法工程师的面试');

    const prep = await call('interview_prep', { company_name: '美团' });
    expect(prep.application_id).toBe(mt.algo);
  });

  it('面试读成了拒信：说一句「那封是面试」，漏斗不留拒信，面试和时间点建上，不追问', async () => {
    llm.push(triage('rejection', { company: '百度' }, '百度感谢信'));
    const wrong = await call('inbox_capture', { text: '【百度】感谢您的投递……诚邀您参加11月4日14:00的二面', source: 'mail' });
    expect(repos.getApplication(baidu)?.stage).toBe('rejected');

    llm.push(triage('interview_invite', { company: '百度', round: '二面', when: INTERVIEW_AT }));
    await correctIntake(deps, wrong.item_id, 'interview_invite');

    expect(repos.getApplication(baidu)?.stage).toBe('interview');
    const history = repos.db.all<{ to_stage: string }>('SELECT to_stage FROM application_history WHERE application_id=?', [baidu]);
    expect(history.map(h => h.to_stage)).not.toContain('rejected');
    expect(repos.listDeadlines({ application_id: baidu }).filter(d => d.kind === 'interview' && d.status === 'open')).toHaveLength(1);
    expect(repos.getInboxItem(wrong.item_id)).toMatchObject({ kind: 'interview_invite', status: 'processed' });
  });

  it('广告读成了笔试：说一句「那是广告」，时间点撤掉、信进已忽略、投递阶段不动', async () => {
    llm.push(triage('written_test', { company: '百度', due_at: '2026-11-05T19:00:00+08:00' }));
    const wrong = await call('inbox_capture', { text: '【某培训】百度笔试押题班 11月5日开课', source: 'mail' });
    expect(repos.listDeadlines({ status: 'open', application_id: baidu })).toHaveLength(1);

    await correctIntake({ ...deps, llm: null }, wrong.item_id, 'ignored');
    expect(repos.listDeadlines({ status: 'open', application_id: baidu })).toHaveLength(0);
    expect(repos.getInboxItem(wrong.item_id)?.status).toBe('dismissed');
    expect(repos.getApplication(baidu)?.stage).toBe('applied');
  });

  it('过了时间的面试不问「去了吗」，问「面完了？」', async () => {
    llm.push(triage('interview_invite', { company: '百度', round: '二面', when: INTERVIEW_AT }));
    await call('inbox_capture', { text: '【百度】二面邀请', source: 'mail' });

    vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z')); // 周三 18:00，面完四小时
    const items = (await call('today_queue')).items.filter(i => i.ref.id === baidu);
    expect(items.map(i => i.kind)).toEqual(['interview_retro']);
    expect(items.some(i => i.ask === 'attendance')).toBe(false);
  });

  it('Offer 来信写了薪酬：归档时就记下，比较前不用用户再报一遍；后一封只补期限、不丢薪酬', async () => {
    llm.push(JSON.stringify({ kind: 'offer', relevance: 'job', fields: { company: '百度', due_at: '2026-11-20', comp: { base: 32000, months: 15, signing: '' } } }));
    await call('inbox_capture', { text: '【百度】录用意向书：月薪 32000，15 薪，请于 11 月 20 日前答复', source: 'mail' });
    llm.push(JSON.stringify({ kind: 'offer', relevance: 'job', fields: { company: '百度', due_at: '2026-11-22' } }));
    await call('inbox_capture', { text: '【百度】答复期限延至 11 月 22 日', source: 'mail' });
    const offers = new CareerStore(repos, deps.core).listOffers().filter(o => o.application_id === baidu);
    expect(offers).toHaveLength(1);
    expect(JSON.parse(offers[0].comp_json)).toEqual({ base: 32000, months: 15 });
    expect(offers[0].deadline?.slice(0, 10)).toBe('2026-11-22');
  });

  it('「我约了百度二面」没说时间：先记上（时间待定），不为时间追问；之后说了时间再记一次只改时间', async () => {
    const first = await call('interview_book', { company_name: '百度', round: '二面' });
    expect(repos.getApplication(baidu)?.stage).toBe('interview');
    expect(repos.getDeadline(first.deadline_id)?.due_at).toBeNull();
    const again = await call('interview_book', { company_name: '百度', round: '二面', when: INTERVIEW_AT });
    expect(again.deadline_id).toBe(first.deadline_id);
    expect(repos.getDeadline(first.deadline_id)?.due_at).toBe(new Date(INTERVIEW_AT).toISOString());
  });

  it('面试页「说几句」直接复盘：写回邀请那场、时间点记完成，不经过对话', async () => {
    llm.push(triage('interview_invite', { company: '百度', round: '二面', when: INTERVIEW_AT }));
    await call('inbox_capture', { text: '【百度】二面邀请', source: 'mail' });
    const store = new CareerStore(repos, deps.core);
    const itv = store.listInterviews().find(i => i.application_id === baidu)!;
    const ask = vi.fn(async () => ({ questions: [{ quote: '召回模型的负样本怎么采？', type: 'project' }], focus_this_round: '负样本' })) as never;
    const out = await runInterviewRetro(store, repos, ask, () => undefined, { transcript: '被问了负样本怎么采，没答好', interview_id: itv.id });
    expect(out.interview_id).toBe(itv.id);
    expect(store.getInterview(itv.id)?.retro_json).toContain('负样本');
    expect(repos.listDeadlines({ application_id: baidu }).find(d => d.kind === 'interview')?.status).toBe('done');
    expect(out.questions_saved).toBe(1);
  });

  it('投出之后这几样工具，回给助理的话里没有让用户「发给我 / 告诉我 / 自己选好再说」', () => {
    const names = ['inbox_capture', 'inbox_correct', 'interview_prep', 'interview_retro', 'interview_book', 'application_correct', 'deadline_done', 'offer_save', 'offer_compare', 'today_queue', 'month_review'];
    for (const name of names) expect(mocks.descriptions.get(name) ?? '', name).not.toMatch(/发给我|告诉我|请问用户|请让用户选|粘给我|贴给我/);
    expect(mocks.descriptions.get('interview_retro')).toContain('不要追问');
  });
});
