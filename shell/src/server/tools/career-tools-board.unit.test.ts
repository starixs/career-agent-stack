import { beforeEach, describe, expect, it, vi } from 'vitest';

// 岗位收藏表格 / 日历相关工具：job_evaluate 不覆盖校招来源维度、deadline_list / deadline_update、jobs_board 与页面同义筛选。
// SDK 的 tool() 被替换成注册表，直接调用 handler；模型用 FakeLLM；数据层用内存 SQLite。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => {
    mocks.handlers.set(name, handler);
    return { name };
  }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('../career/skills', () => ({ loadSkillPrompt: vi.fn(async (name: string) => `skill:${name}`) }));

import { FakeLLM, type Deadline } from '@career/core';

import { boardMeta } from '../career/job-board';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer, filterBoardFacets, mergeEvaluatePrefilter, selectDeadlines } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { ...res, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

describe('mergeEvaluatePrefilter', () => {
  it('保留 campus 等来源键，只替换 evaluate；坏 JSON / 空值也安全', () => {
    const campus = { campus: { batch: '正式批', industry: '互联网' } };
    expect(JSON.parse(mergeEvaluatePrefilter(JSON.stringify(campus), { pass: false, reasons: ['届别不符'] })!)).toEqual({ ...campus, evaluate: { pass: false, reasons: ['届别不符'] } });
    expect(JSON.parse(mergeEvaluatePrefilter(JSON.stringify({ ...campus, evaluate: { pass: true } }), null)!)).toEqual(campus);
    expect(mergeEvaluatePrefilter(null, null)).toBeNull();
    expect(JSON.parse(mergeEvaluatePrefilter('{坏', { pass: true })!)).toEqual({ evaluate: { pass: true } });
  });
});

describe('selectDeadlines', () => {
  const NOW = '2026-10-16T04:00:00.000Z';
  const d = (id: string, due_at: string, status: Deadline['status'] = 'open', kind: Deadline['kind'] = 'written_test') => ({ id, title: id, kind, due_at, status } as Deadline);
  const all = [d('past_missed', '2026-10-10T02:00:00.000Z', 'missed'), d('past_done', '2026-10-11T02:00:00.000Z', 'done'), d('soon', '2026-10-17T02:00:00.000Z', 'open', 'interview'),
    d('in_20d', '2026-11-05T02:00:00.000Z'), d('in_60d', '2026-12-15T02:00:00.000Z')];
  it('缺省：未完成的、30 天内到期的（含已过期没处理的），按时间排序', () => {
    expect(selectDeadlines(all, {}, NOW).map(x => x.id)).toEqual(['past_missed', 'soon', 'in_20d']);
  });
  it('from / to / kind / status 组合；from 给定时不再默认 30 天上限', () => {
    expect(selectDeadlines(all, { from: '2026-10-17T00:00:00.000Z' }, NOW).map(x => x.id)).toEqual(['soon', 'in_20d', 'in_60d']);
    expect(selectDeadlines(all, { kind: 'interview' }, NOW).map(x => x.id)).toEqual(['soon']);
    expect(selectDeadlines(all, { status: 'all', to: '2026-10-12T00:00:00.000Z' }, NOW).map(x => x.id)).toEqual(['past_missed', 'past_done']);
  });
});

describe('career 岗位表格 / 日历工具', () => {
  let llm: FakeLLM;
  let events: Array<{ event: string; data: unknown }>;
  let repos: ReturnType<typeof createMemoryRepos>;

  beforeEach(async () => {
    mocks.handlers.clear();
    llm = new FakeLLM();
    events = [];
    repos = createMemoryRepos();
    await createCareerServer({ repos, llm, broadcast: (event, data) => events.push({ event, data }), sessionId: () => 'sess-1' });
  });

  it('job_evaluate 把预筛写到 prefilter_json.evaluate，不抹掉校招来源的批次 / 行业', async () => {
    const job = repos.upsertJob({
      source_platform: 'campus', source_job_id: 'c1', title: '后端开发', company_name: '甲',
      prefilter_json: JSON.stringify({ campus: { batch: '正式批', industry: '互联网' } }),
      jd_parsed_json: JSON.stringify({ title: '后端开发', hard_requirements: [] }),
    });
    llm.push(JSON.stringify({ prefilter: { pass: true }, scores: { fit: 4 }, verdict: 'good' }));
    const res = await call('job_evaluate', { job_id: job.id });
    expect(res.isError).toBeUndefined();
    const after = repos.getJob(job.id)!;
    expect(JSON.parse(after.prefilter_json!)).toEqual({ campus: { batch: '正式批', industry: '互联网' }, evaluate: { pass: true } });
    expect(boardMeta(after)).toEqual({ batch: '正式批', industry: '互联网', type_tags: [] });
    expect(JSON.parse(after.score_json!).verdict).toBe('good');
  });

  it('deadline_list 能看到 3 天以外的日程并带公司；deadline_update 改期、过期的改到将来重新打开', async () => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '乙公司' });
    const app = repos.createApplication(job.id);
    const far = repos.createDeadline({ kind: 'written_test', title: '乙公司笔试', due_at: new Date(Date.now() + 10 * 86_400_000).toISOString(), application_id: app.id });
    const missed = repos.createDeadline({ kind: 'assessment', title: '丙测评', due_at: new Date(Date.now() - 86_400_000).toISOString() });
    repos.setDeadlineStatus(missed.id, 'missed');
    repos.createDeadline({ kind: 'other', title: '很远', due_at: new Date(Date.now() + 90 * 86_400_000).toISOString() });

    const listed = (await call('deadline_list')).json();
    const rows = listed.deadlines as Array<Record<string, unknown>>;
    expect(rows.map(r => r.title)).toEqual(['丙测评', '乙公司笔试']);
    expect(rows[0]).toMatchObject({ id: missed.id, overdue: true, status: 'missed' });
    expect(rows[1]).toMatchObject({ id: far.id, company: '乙公司', application_id: app.id, job_id: job.id, kind: 'written_test' });

    const newDue = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const updated = (await call('deadline_update', { deadline_id: missed.id, due_at: newDue, title: '丙公司测评', note: '延期了' })).json().deadline as Deadline;
    expect(updated).toMatchObject({ title: '丙公司测评', note: '延期了', status: 'open', due_at: newDue });
    expect(events.at(-1)).toMatchObject({ event: 'career:data-changed', data: { tables: ['deadline'] } });

    expect((await call('deadline_update', { deadline_id: missed.id })).isError).toBe(true);
    expect((await call('deadline_update', { deadline_id: 'ddl_missing', title: 'x' })).isError).toBe(true);
    expect((await call('deadline_update', { deadline_id: missed.id, due_at: '不是时间' })).isError).toBe(true);
  });

  it('jobs_board 按批次 / 类型 / 地点 / 进度筛选，返回总数、已用条件与表格列', async () => {
    const mk = (id: string, campus: Record<string, unknown>, extra: Record<string, unknown> = {}) => repos.upsertJob({ source_platform: 'campus', source_job_id: id, title: `岗位${id}`, company_name: `公司${id}`, employment_type: 'campus', prefilter_json: JSON.stringify({ campus }), ...extra });
    const a = mk('a', { batch: '正式批', industry: '互联网' }, { location: '北京/上海' });
    mk('b', { batch: '提前批', industry: '互联网' }, { location: '北京' });
    const c = mk('c', { batch: '正式批', industry: '央国企' }, { location: '深圳' });
    mk('d', { batch: '正式批', industry: '金融' }, { location: '北京', employment_type: 'intern' });
    repos.createApplication(c.id);

    const out = (await call('jobs_board', { batch: ['正式批'], location: ['北京', '深圳'], type: ['校招'] })).json();
    expect(out.total).toBe(2);
    expect(out.filters).toEqual({ batch: ['正式批'], location: ['北京', '深圳'], type: ['校招'] });
    const rows = out.rows as Array<Record<string, unknown>>;
    expect(rows.map(r => r.job_id).sort()).toEqual([a.id, c.id].sort());
    expect(rows.find(r => r.job_id === c.id)).toMatchObject({ batch: '正式批', industry: null, type_tags: ['校招', '央国企'], stage: 'active' });
    expect(rows.find(r => r.job_id === a.id)).toMatchObject({ industry: '互联网', type_tags: ['校招'], stage: 'none' });

    expect((await call('jobs_board', { type: ['央国企'] })).json().total).toBe(1);
    expect((await call('jobs_board', { type: ['intern'] })).json().total).toBe(1);
    expect((await call('jobs_board', { stage: ['none'], q: '公司b' })).json().total).toBe(1);
    expect((await call('jobs_board', { job_ids: [a.id] })).json().total).toBe(1);
    const limited = (await call('jobs_board', { limit: 1 })).json();
    expect(limited).toMatchObject({ total: 4, returned: 1 });
  });

  it('filterBoardFacets 与页面语义一致：维度内任一命中，维度间取交集，空数组不限', () => {
    const row = (batch: string | null, location: string) => ({ job: { company_name: 'X', title: 'Y', location, employment_type: 'campus' }, meta: { batch, industry: null, type_tags: [] }, application: null }) as never;
    const rows = [row('正式批', '北京、上海'), row(null, '杭州')];
    expect(filterBoardFacets(rows, { batch: [], location: ['上海'] })).toHaveLength(1);
    expect(filterBoardFacets(rows, { batch: ['正式批', '提前批'], location: ['杭州'] })).toHaveLength(0);
    expect(filterBoardFacets(rows, {})).toHaveLength(2);
  });
});
