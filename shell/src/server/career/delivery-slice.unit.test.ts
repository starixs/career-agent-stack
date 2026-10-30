/**
 * 投递切面落地（世界模型 §7.1 情景 B、C）：服务端走一遍，等你条、批次卡、回来卡读到的是同一份数据。
 *
 * B. 关键期的一个周二：09:10「这 20 个都投了」（美团、京东、华为标了星）→ 20 家都缺证件号码，填一次全部放行 →
 *    两个网站要登录 → 10:30 九方云测评明晚截止 → 14:10 拼多多拒信（只计数）。
 * C. 两天没开回来：1 个面试邀请、2 个笔试 / 测评、2 封拒信，其余 13 家没回音；最急的是今晚截止的测评。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, type Repos } from '@career/core';

import { handleCareerRoute } from '../routes/career';
import { loadCore } from './core-module';
import { BATCH_COMMAND_KEY } from './batch-runner';
import { captureIntake } from './intake';
import { setTargetJob } from './targets';
import { createMemoryRepos } from './test-db';

async function get(repos: Repos, path: string, body?: unknown) {
  const request = new Request(`http://local${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const res = await handleCareerRoute(new URL(request.url).pathname, request, { repos, broadcast: () => undefined, sessionId: () => 'global', llm: null });
  if (!res) throw new Error(`没有这个接口：${path}`);
  return await res.json() as Record<string, unknown>;
}

async function mail(repos: Repos, llm: FakeLLM, at: string, triage: Record<string, unknown>) {
  vi.setSystemTime(new Date(at));
  llm.push(JSON.stringify(triage));
  await captureIntake({ repos, core: await loadCore(), llm, broadcast: () => undefined, sessionId: () => 'global', now: () => at }, { text: String(triage.summary), source: 'mail' });
}

type Ask = { id: string; kind: string; title: string; application_ids: string[]; sources: Array<{ id: string }> };
type Run = { total: number; done: number; asking: number; items: Array<{ company: { name: string; logo?: string }; star: boolean; state: string }> };

const TARGETS = ['美团', '京东', '华为'];
const WIDE = ['DeepSeek', '中兴通讯', '中电福富', '元戎启行', '字节跳动', '拼多多', '摩尔线程', '智元', '科大讯飞', '理想汽车', '腾讯混元', '阿里巴巴', '荣耀', '长飞', '联发科技', '大疆', '普渡机器人'];

describe('情景 B · 关键期的一个周二，投 20 家', () => {
  let repos: Repos;
  let llm: FakeLLM;
  /** 周二 00:00（北京）= 客户端给的本地零点 */
  const DAY = '2026-10-27T16:00:00.000Z';
  const appOf = (c: string) => repos.applicationsWithJob().find(a => a.job.company_name === c)!;
  const asks = async () => (await get(repos, `/api/career/asks?since=${DAY}`)) as { asks: Ask[]; run: Run };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T01:10:00.000Z'));
    repos = createMemoryRepos();
    llm = new FakeLLM();
    // 九方云是前几天投的，不在这一批
    repos.jumpTo(repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'j-九方云', title: 'AI应用开发', company_name: '九方云' }).id).id, 'applied', '已投递');
    // 09:10「这 20 个都投了」：每家一份待投的填表动作（jobs_prepare 的结果）
    for (const c of [...TARGETS, ...WIDE]) {
      const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${c}`, title: 'AI应用开发', company_name: c });
      if (TARGETS.includes(c)) setTargetJob(repos, job.id, true);
      repos.enqueueAction('fill_form', { job_id: job.id }, repos.createApplication(job.id).id);
    }
  });
  afterEach(() => { vi.useRealTimers(); });

  it('一句话开的 20 家：等你条只有一件「20 家等你说开始」；批次卡标星的 3 家在前，美团用色块标志', async () => {
    const { asks: list, run } = await asks();
    expect(list.map(a => a.title)).toEqual(['20 家等你说开始']);
    expect(list[0].sources).toHaveLength(20);
    expect(run).toMatchObject({ total: 20, done: 0 });
    expect(run.items.slice(0, 3).map(i => [i.company.name, i.star])).toEqual(TARGETS.map(c => [c, true]));
    expect(run.items[0].company.logo).toBe('mt');
  });

  it('09:16 20 家都缺证件号码：一件事，填一次全部放行；09:48 两个网站要登录合成一件；10:30 九方云测评排到第一', async () => {
    repos.reviewActions(repos.listActions('pending_review').map(a => a.id), 'approved');
    const fills = repos.listActions('approved');
    for (const a of fills) {
      const h = repos.openHandoff(['摩尔线程', '智元'].some(c => appOf(c).id === a.application_id) ? 'login' : 'missing_info', { actionId: a.id });
      if (h.reason === 'missing_info') repos.setActionStatus(a.id, 'needs_user', { needsUser: [{ label: '证件号码', key: 'idNumber' }], gate: { gaps: [{ label: '证件号码', status: 'needs_user', required: true }] } });
    }
    await mail(repos, llm, '2026-10-28T02:30:00.000Z', { kind: 'assessment', relevance: 'job', fields: { company: '九方云', title: 'AI应用开发', due_at: '2026-10-29T23:59:00+08:00' }, summary: '九方云在线测评，明晚截止' });

    const { asks: list, run } = await asks();
    expect(list.map(a => [a.kind, a.title])).toEqual([['deadline', '九方云 · AI应用开发 测评'], ['info', '证件号码'], ['login', '2 个网站要你登录']].map(([k, t]) => [k, expect.stringContaining(t.split(' ')[0])]));
    expect(list[1].application_ids).toHaveLength(18);
    expect(run.asking).toBe(20);

    // 证件号码在等你条里填一次：存进本机私密库，18 份一起交给后台从当前页接着填，不经过对话、不用再点
    const out = await get(repos, `/api/career/asks/${list[1].id}/fill`, { values: { 证件号码: '110101200001011234' } });
    expect(out).toMatchObject({ ok: true, still_waiting: 0 });
    expect(out.resumed).toHaveLength(18);
    expect(repos.openHandoffs().filter(h => h.reason === 'missing_info')).toHaveLength(0);
    expect(repos.kvGet<{ cmd: string; ids: string[] }>(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', ids: out.resumed });
    expect(JSON.stringify(out)).not.toContain('110101');
    // 刷新后也不会再冒出来：服务端那一批源都已处理
    expect((await asks()).asks.map(a => a.kind)).toEqual(['deadline', 'login']);
  });

  it('18:30 海投跑完：投出 17 / 20；拼多多的拒信只计数，不进等你条', async () => {
    repos.reviewActions(repos.listActions('pending_review').map(a => a.id), 'approved');
    for (const c of [...TARGETS, ...WIDE].filter(c => !['华为', '摩尔线程', '智元'].includes(c))) repos.jumpTo(appOf(c).id, 'applied', '已投递');
    await mail(repos, llm, '2026-10-28T06:10:00.000Z', { kind: 'rejection', relevance: 'job', fields: { company: '拼多多' }, summary: '拼多多：很遗憾' });
    const { asks: list, run } = await asks();
    expect(run).toMatchObject({ total: 20, done: 17 });
    expect(list.map(a => a.title).join()).not.toContain('拼多多');
  });
});

describe('情景 C · 两天没开，回来', () => {
  let repos: Repos;
  let llm: FakeLLM;
  const LEFT_AT = '2026-10-28T13:00:00.000Z';
  const NOW = '2026-10-30T10:00:00.000Z';
  const SILENT = ['美团', '腾讯', '阿里巴巴', '字节跳动', '网易', '小红书', '快手', '滴滴', '携程', '米哈游', '哔哩哔哩', '蔚来', '理想'];
  const REPLIED = ['九方云', '讯飞', '百度', '拼多多', '京东'];
  const away = async () => ((await get(repos, `/api/career/away?since=${LEFT_AT}`)).away) as { asks: Ask[]; sent: unknown[]; replies: Array<{ label: string; n: number; companies: Array<{ name: string }> }>; quiet: number };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T02:00:00.000Z'));
    repos = createMemoryRepos();
    llm = new FakeLLM();
    for (const c of [...SILENT, ...REPLIED]) repos.jumpTo(repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${c}`, title: '后端开发', company_name: c }).id).id, 'applied', '已投递');
    await mail(repos, llm, '2026-10-29T02:00:00.000Z', { kind: 'assessment', relevance: 'job', fields: { company: '九方云', title: '后端开发', due_at: '2026-10-30T23:59:00+08:00' }, summary: '九方云在线测评，今晚截止' });
    await mail(repos, llm, '2026-10-29T03:00:00.000Z', { kind: 'written_test', relevance: 'job', fields: { company: '讯飞', title: '后端开发', when: '2026-11-02T19:00:00+08:00' }, summary: '讯飞笔试下周一' });
    await mail(repos, llm, '2026-10-29T06:00:00.000Z', { kind: 'interview_invite', relevance: 'job', fields: { company: '百度', title: '后端开发', round: '一面', when: '2026-11-01T14:00:00+08:00' }, summary: '百度一面周日' });
    await mail(repos, llm, '2026-10-29T08:00:00.000Z', { kind: 'rejection', relevance: 'job', fields: { company: '拼多多' }, summary: '拼多多：很遗憾' });
    await mail(repos, llm, '2026-10-30T01:00:00.000Z', { kind: 'rejection', relevance: 'job', fields: { company: '京东' }, summary: '京东：很遗憾' });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('回来卡：最急的一件是今晚截止的测评，出处是那封信；下面三行是回音的数字和公司；其余 13 家没回音', async () => {
    const a = await away();
    expect(a.asks[0].title).toContain('九方云');
    expect(a.replies.map(r => [r.label, r.n])).toEqual([['面试邀请', 1], ['笔试 / 测评', 2], ['不合适', 2]]);
    expect(a.replies[2].companies.map(c => c.name).sort()).toEqual(['京东', '拼多多']);
    expect(a.quiet).toBe(SILENT.length);
    expect(a.sent).toEqual([]); // 不在的两天里没有新投出的
    expect(a.asks[0]).toMatchObject({ role: '后端开发' });
  });

  it('在通知中心把测评做完：回来卡和等你条都不再有它（同一个 id）', async () => {
    const first = (await away()).asks[0];
    repos.setDeadlineStatus(first.id, 'done');
    expect((await away()).asks.map(x => x.id)).not.toContain(first.id);
    expect(((await get(repos, '/api/career/asks')).asks as Ask[]).map(x => x.id)).not.toContain(first.id);
  });
});
