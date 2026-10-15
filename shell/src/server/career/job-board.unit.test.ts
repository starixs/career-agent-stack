import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobListing } from '@career/core';

import { loadCore } from './core-module';
import { CAMPUS_SEEDED_KEY, boardMeta, computeMatches, jobBoard, prepareJobs, seedCampusJobsIfEmpty, setJobPrefs } from './job-board';
import { RemoteJobSource, syncJobSource, uploadAnswerEvents, upsertListings } from './server-api';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';
import { exportCareerWorkbook } from './xlsx-export';

// 阶段 3：岗位汇总表、可解释匹配、服务端岗位库同步、答案改动回传、导出表格。

let dir: string;
const core = await loadCore();
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-board-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, await loadCore());
  const exp = repos.createExperience({ title: '数据分析实习', org: '某电商' });
  const c = repos.addClaim({ experience_id: exp.id, text: '在 Hive 上写 SQL 做留存分析' });
  repos.confirmClaim(c.id);
  repos.addClaim({ experience_id: exp.id, text: '用 PyTorch 训练推荐模型' }); // pending：不能当证据
  return { repos, store };
}

const listing = (over: Partial<JobListing>): JobListing => ({ job_key: 'srv:1', remote_id: 'r1', source_platform: 'moka', company_name: '甲', title: '数据分析实习生', employment_type: 'intern', cohort: '2027届', location: '上海', jd_raw: '熟练 SQL，了解深度学习', version: 1, ...over });

describe('岗位汇总表与匹配', () => {
  it('只用已确认的主张当证据；违反条件的排在后面、可筛掉；我的进度并入', async () => {
    const { repos, store } = await setup();
    upsertListings(repos, [listing({}), listing({ job_key: 'srv:2', remote_id: 'r2', title: '数据分析（社招）', employment_type: 'social', location: '北京' })], core);
    setJobPrefs(repos, { cohort: '2027届', cities: ['上海'], employment_types: ['intern', 'campus'] });
    computeMatches(repos, store, undefined, '2026-10-10');
    const rows = jobBoard(repos, {}, '2026-10-10');
    expect(rows[0].job.job_key).toBe('srv:1');
    const m = rows[0].match!;
    expect(m.hard_ok).toBe(true);
    expect(m.requirements.find(r => r.requirement === 'SQL')).toMatchObject({ status: 'covered', evidence: { label: '某电商 · 数据分析实习' } });
    expect(m.requirements.find(r => r.requirement === '深度学习')!.status).toBe('missing'); // pending 主张不算
    expect(rows[1].match!.hard_ok).toBe(false);
    expect(jobBoard(repos, { fits_only: true }, '2026-10-10').map(r => r.job.job_key)).toEqual(['srv:1']);
    const app = repos.createApplication(rows[0].job.id);
    expect(jobBoard(repos, { progress: 'active' }).map(r => r.application?.id)).toEqual([app.id]);
    expect(jobBoard(repos, { progress: 'none' }).map(r => r.job.job_key)).toEqual(['srv:2']);
  });

  it('勾选加入待投清单：冻结材料包、fill_form 待审；已在投的跳过；没有链接的说明原因', async () => {
    const { repos, store } = await setup();
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    upsertListings(repos, [listing({ url: 'https://a.com/1' }), listing({ job_key: 'srv:2', remote_id: 'r2', url: null })], core);
    const [a, b] = repos.listJobs().sort((x, y) => (x.job_key! < y.job_key! ? -1 : 1));
    const exportPdf = async (id: string) => { const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${id}`); return p; };
    const deps = { repos, store, exportPdf, exportsDir: dir };
    const first = await prepareJobs(deps, [a.id, b.id]);
    expect(first).toEqual([expect.objectContaining({ job_id: a.id, ok: true }), expect.objectContaining({ job_id: b.id, ok: false, reason: '没有网申链接' })]);
    const action = repos.getAction(first[0].action_id!)!;
    expect(action.status).toBe('pending_review');
    expect(action.packet_id).toBeTruthy();
    expect((await prepareJobs(deps, [a.id]))[0]).toMatchObject({ ok: false, reason: '已在待投清单或正在投' });
  });
});

describe('服务端岗位库', () => {
  it('按 job_key 增量 upsert；版本没变不覆盖；下架的保留标记', async () => {
    const { repos } = await setup();
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      first: { items: [listing({}), listing({ job_key: 'srv:2', remote_id: 'r2', title: '产品实习' })], next_cursor: 'p2' },
      p2: { items: [listing({ job_key: 'srv:3', remote_id: 'r3', title: '运营实习', status: 'closed' })], next_cursor: null },
    };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t0k');
      const cursor = new URL(url).searchParams.get('cursor');
      return new Response(JSON.stringify(pages[cursor ?? 'first']), { status: 200 });
    };
    const src = new RemoteJobSource({ base_url: 'https://api.test', token: 't0k' }, fetchImpl);
    const res = await syncJobSource(repos, src, { updated_since: '2026-10-01T00:00:00Z' });
    expect(res).toEqual({ fetched: 3, stored: 3 });
    expect(calls[0]).toContain('/v1/jobs?updated_since=');
    expect(repos.getJobByKey('srv:3')!.source_status).toBe('closed');
    // 同版本再来一次不覆盖本地；新版本覆盖
    repos.db.update('job', repos.getJobByKey('srv:1')!.id, { title: '本地改过的标题' });
    expect(upsertListings(repos, [listing({})], core)).toBe(0);
    expect(upsertListings(repos, [listing({ version: 2, title: '数据分析实习生（更新）' })], core)).toBe(1);
    expect(repos.getJobByKey('srv:1')!.title).toBe('数据分析实习生（更新）');
  });

  it('答案改动回传：只传待传的、不带本地投递 id；失败保留待重试', async () => {
    const { repos } = await setup();
    const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'x', title: 't' }).id);
    repos.saveAnswer({ question_key: '期望城市', question_text: '期望城市', answer: '上海', application_id: app.id });
    repos.saveAnswer({ question_key: '是否使用AI', question_text: '你是否使用了 AI 工具作答', answer: '否' });
    let body: { events: Array<Record<string, unknown>> } | null = null;
    const ok = await uploadAnswerEvents(repos, { base_url: 'https://api.test' }, async (_u, init) => { body = JSON.parse(String(init?.body)); return new Response('{}', { status: 200 }); });
    expect(ok.uploaded).toBe(1);
    expect(body!.events).toHaveLength(1);
    expect(body!.events[0]).toMatchObject({ question_text: '期望城市', answer: '上海', job_key: 'campus:x' });
    expect(body!.events[0]).not.toHaveProperty('application_id');
    repos.saveAnswer({ question_key: '期望城市', question_text: '期望城市', answer: '杭州' });
    const bad = await uploadAnswerEvents(repos, { base_url: 'https://api.test' }, async () => new Response('down', { status: 503 }));
    expect(bad.error).toMatch(/503/);
    expect(repos.pendingAnswerEvents()).toHaveLength(1);
  });
});

describe('导出表格', () => {
  it('岗位汇总 / 投递进度 / 网申答案三张表，个人信息不导出值', async () => {
    const { repos } = await setup();
    upsertListings(repos, [listing({})], core);
    repos.createApplication(repos.listJobs()[0].id);
    repos.saveAnswer({ question_key: '手机号', question_text: '手机号', answer: '13800000000' });
    const res = await exportCareerWorkbook(repos, dir, new Date('2026-10-10T08:00:00Z'));
    expect(res.path).toMatch(/求职表格-20261010\.xlsx$/);
    expect(res.sheets).toMatchObject({ 岗位汇总: 1, 投递进度: 1, 网申答案: 1 });
    const XLSX = await import('xlsx');
    const wb = XLSX.read((await import('fs')).readFileSync(res.path));
    const answers = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['网申答案']);
    expect(answers[0].答案).toBe('（个人信息，不导出）');
  });
});

describe('多维表格维度与投递记录摘要', () => {
  it('boardMeta：批次 / 行业来自校招来源的 prefilter_json；企业性质归到类型标签；拿不到就为空', () => {
    expect(boardMeta({ prefilter_json: JSON.stringify({ campus: { batch: '正式批', industry: '互联网' } }) })).toEqual({ batch: '正式批', industry: '互联网', type_tags: [] });
    expect(boardMeta({ prefilter_json: JSON.stringify({ campus: { batch: '提前批', industry: '央国企' } }) })).toEqual({ batch: '提前批', industry: null, type_tags: ['央国企'] });
    expect(boardMeta({ prefilter_json: JSON.stringify({ campus: { industry: '其他' } }) })).toEqual({ batch: null, industry: null, type_tags: [] });
    expect(boardMeta({ prefilter_json: '{坏 json' })).toEqual({ batch: null, industry: null, type_tags: [] });
    expect(boardMeta({ prefilter_json: null })).toEqual({ batch: null, industry: null, type_tags: [] });
  });

  it('boardMeta：board_json 优先；评估把预筛并到 prefilter_json.evaluate 后仍能读到 campus；evaluate 里的字段不当维度', () => {
    expect(boardMeta({ board_json: JSON.stringify({ batch: '实习', industry: '游戏', type_tags: [] }), prefilter_json: JSON.stringify({ campus: { batch: '正式批' } }) })).toEqual({ batch: '实习', industry: '游戏', type_tags: [] });
    expect(boardMeta({ prefilter_json: JSON.stringify({ campus: { batch: '正式批', industry: '外企' }, evaluate: { pass: true, industry: '金融' } }) })).toEqual({ batch: '正式批', industry: null, type_tags: ['外企'] });
    expect(boardMeta({ prefilter_json: JSON.stringify({ evaluate: { batch: '提前批' } }) })).toEqual({ batch: null, industry: null, type_tags: [] });
    expect(boardMeta({ board_json: '坏', prefilter_json: JSON.stringify({ campus: ['不是对象'] }) })).toEqual({ batch: null, industry: null, type_tags: [] });
  });

  it('服务端同步带批次 / 行业 / 类型标签 → board_json；后续不带这些字段的新版本不抹掉', async () => {
    const { repos } = await setup();
    upsertListings(repos, [listing({ batch: '正式批', industry: '银行/金融', type_tags: ['央国企'] })], core);
    expect(jobBoard(repos)[0].meta).toEqual({ batch: '正式批', industry: '银行/金融', type_tags: ['央国企'] });
    upsertListings(repos, [listing({ version: 2, title: '数据分析实习生（更新）' })], core);
    expect(jobBoard(repos)[0].meta).toEqual({ batch: '正式批', industry: '银行/金融', type_tags: ['央国企'] });
  });

  it('岗位表为空时首次自动导入校招数据一次；之后不再导入；有岗位时不导入；读不到数据不抛错', async () => {
    const { repos, store } = await setup();
    let loads = 0;
    const bridges = {
      loadCampusJobs: () => { loads++; return [{ company: '甲', positions: ['研发'], locations: ['上海'], batch: '正式批', industry: '互联网' }]; },
      filterCampusJobs: (items: never[]) => items,
      importCampusJobs: (r: typeof repos, items: Array<{ company: string; positions: string[] }>) => items.map(i => r.upsertJob({ source_platform: 'campus', source_job_id: i.company, title: i.positions.join('/'), company_name: i.company, board_json: core.serializeBoardMeta({ batch: '正式批', industry: '互联网' }) })),
    } as unknown as Parameters<typeof seedCampusJobsIfEmpty>[2];
    expect(seedCampusJobsIfEmpty(repos, store, bridges)).toEqual({ stored: 1 });
    expect(repos.kvGet(CAMPUS_SEEDED_KEY)).toBeTruthy();
    expect(jobBoard(repos)[0].meta).toEqual({ batch: '正式批', industry: '互联网', type_tags: [] });
    repos.db.run('DELETE FROM job');
    expect(seedCampusJobsIfEmpty(repos, store, bridges)).toBeNull();
    expect(loads).toBe(1);

    const other = await setup();
    other.repos.upsertJob({ source_platform: 'manual', title: '已有岗位' });
    expect(seedCampusJobsIfEmpty(other.repos, other.store, bridges)).toBeNull();
    const fresh = await setup();
    const broken = { ...bridges, loadCampusJobs: () => { throw new Error('ENOENT jobs.json'); } } as typeof bridges;
    expect(seedCampusJobsIfEmpty(fresh.repos, fresh.store, broken)).toBeNull();
    expect(fresh.repos.kvGet(CAMPUS_SEEDED_KEY)).toBeFalsy();
  });

  it('jobBoard 每行带 meta', async () => {
    const { repos } = await setup();
    repos.upsertJob({ source_platform: 'campus', source_job_id: 'c1', title: '后端', company_name: '甲', prefilter_json: JSON.stringify({ campus: { batch: '正式批', industry: '外企' } }) });
    expect(jobBoard(repos)[0].meta).toEqual({ batch: '正式批', industry: null, type_tags: ['外企'] });
  });

  it('dossierSummaries：投递时间、到过的阶段、测评 / 笔试安排、岗位链接', async () => {
    const { repos, store } = await setup();
    const job = repos.upsertJob({ source_platform: 'manual', title: '产品', company_name: '甲', url: 'https://a.com/j' });
    const app = repos.createApplication(job.id);
    repos.jumpTo(app.id, 'applied');
    repos.transition(app.id, 'rejected');
    repos.createDeadline({ kind: 'written_test', title: '甲笔试', due_at: '2026-10-05T04:00:00.000Z', application_id: app.id });
    const cancelled = repos.createDeadline({ kind: 'assessment', title: '甲测评', due_at: '2026-10-04T04:00:00.000Z', application_id: app.id });
    repos.setDeadlineStatus(cancelled.id, 'cancelled');
    const s = store.dossierSummaries().find(x => x.application_id === app.id)!;
    expect(s.applied_at).toEqual(expect.any(String));
    expect(s.created_at).toBe(app.created_at);
    expect(s.reached_stages).toEqual(expect.arrayContaining(['evaluated', 'applied', 'rejected']));
    expect(s.exam_kinds).toEqual(['written_test']);
    expect(s.job_url).toBe('https://a.com/j');
  });
});
