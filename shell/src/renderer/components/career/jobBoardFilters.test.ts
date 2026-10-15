import { describe, expect, it } from 'vitest';

import { ASK_REF_JOB_LIMIT, DEFAULT_BOARD_FILTER, batchLabel, boardAskRefs, facetOptions, filterBoardRows, typeTagsOf } from './jobBoardFilters';
import type { JobBoardRow } from './types';

const row = (id: string, over: { job?: Partial<JobBoardRow['job']>; meta?: JobBoardRow['meta']; stage?: string; score?: number; hard_ok?: boolean }): JobBoardRow => ({
  job: {
    id, source_platform: 'campus', source_job_id: null, url: null, company_id: null, company_name: `${id}公司`, title: `${id}岗位`, location: null, salary: null,
    jd_raw: null, jd_parsed_json: null, prefilter_json: null, score_json: null, deadline: null, deadline_verified_at: null, created_at: '2026-10-01', updated_at: '2026-10-01',
    ...over.job,
  },
  match: over.score === undefined ? null : { score: over.score, hard_ok: over.hard_ok ?? true, hard: [], requirements: [], covered: 0, total: 0, summary: '', computed_at: '' },
  application: over.stage ? { id: `app-${id}`, stage: over.stage as never, next_action: null, updated_at: '2026-10-01' } : null,
  meta: over.meta,
});

const rows: JobBoardRow[] = [
  row('甲', { job: { employment_type: 'campus', cohort: '2027届', location: '北京/上海', deadline: '2026-10-20' }, meta: { batch: '正式批', industry: '互联网', type_tags: [] }, score: 80 }),
  row('乙', { job: { employment_type: 'intern', location: '上海', deadline: '2026-10-01' }, meta: { batch: '实习', industry: null, type_tags: ['央国企'] }, score: 60, stage: 'applied' }),
  row('丙', { job: { employment_type: 'campus', location: '深圳', deadline: '2026-11-01' }, meta: { batch: '正式批', industry: '半导体/硬件', type_tags: ['外企'] }, score: 90, hard_ok: false, stage: 'approved' }),
];
const TODAY = '2026-10-13';

describe('岗位收藏筛选（选项来自已有取值，不做条件编辑器）', () => {
  it('维度选项按条数倒序；进度按固定顺序；地点拆成单个城市', () => {
    expect(facetOptions(rows, 'batch')).toEqual([{ value: '正式批', label: '正式批', count: 2 }, { value: '实习', label: '实习', count: 1 }]);
    expect(facetOptions(rows, 'city').map(o => [o.value, o.count])).toEqual([['上海', 2], ['北京', 1], ['深圳', 1]]);
    expect(facetOptions(rows, 'tag').map(o => o.value)).toEqual(['校招', '实习', '外企', '央国企']); // 同条数按拼音
    expect(facetOptions(rows, 'progress').map(o => o.label)).toEqual(['未投递', '进行中', '已投出']);
  });

  it('默认只看没截止，按匹配分排序', () => {
    expect(filterBoardRows(rows, DEFAULT_BOARD_FILTER, TODAY).map(r => r.job.id)).toEqual(['丙', '甲']);
  });

  it('同一维度多选取并集，不同维度取交集；搜索只看公司 / 岗位；只看符合我条件', () => {
    const base = { ...DEFAULT_BOARD_FILTER, openOnly: false };
    expect(filterBoardRows(rows, { ...base, city: ['上海', '深圳'] }, TODAY).map(r => r.job.id)).toEqual(['丙', '甲', '乙']);
    expect(filterBoardRows(rows, { ...base, city: ['上海'], tag: ['实习'] }, TODAY).map(r => r.job.id)).toEqual(['乙']);
    expect(filterBoardRows(rows, { ...base, progress: ['active'] }, TODAY).map(r => r.job.id)).toEqual(['丙']);
    expect(filterBoardRows(rows, { ...base, q: '乙公司' }, TODAY).map(r => r.job.id)).toEqual(['乙']);
    expect(filterBoardRows(rows, { ...base, q: '上海' }, TODAY)).toEqual([]);
    expect(filterBoardRows(rows, { ...base, fitsOnly: true, sort: 'deadline' }, TODAY).map(r => r.job.id)).toEqual(['乙', '甲']);
  });

  it('类型标签合并雇佣类型与企业性质；批次带上简写届别', () => {
    expect(typeTagsOf(rows[1])).toEqual(['实习', '央国企']);
    expect(batchLabel(rows[0])).toBe('27届 · 正式批');
    expect(batchLabel(rows[1])).toBe('实习');
  });
});

describe('boardAskRefs', () => {
  it('drops empty filters, caps visible ids and serializes to strings', () => {
    const ids = Array.from({ length: ASK_REF_JOB_LIMIT + 5 }, (_, i) => `j${i}`);
    const refs = boardAskRefs({ ...DEFAULT_BOARD_FILTER, openOnly: false, city: ['上海'], sort: 'deadline' }, ids, []);
    expect(refs.filters).toBe(JSON.stringify({ city: ['上海'], sort: 'deadline' }));
    expect(refs.job_ids?.split(',')).toHaveLength(ASK_REF_JOB_LIMIT);
    expect(refs.selected_job_ids).toBeUndefined();
  });

  it('sends nothing for a default, empty board', () => {
    expect(boardAskRefs({ ...DEFAULT_BOARD_FILTER, openOnly: false }, [], [])).toEqual({ filters: undefined, job_ids: undefined, selected_job_ids: undefined });
  });
});
