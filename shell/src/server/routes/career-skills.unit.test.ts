import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute, type CareerRouteDeps } from './career';

// 技能成果的读取接口：落了库的成果，页面要读得到（预测追问此前没有读取路由，面试页永远是空的）。

const tempDirs: string[] = [];

function makeDeps(repos: Repos): CareerRouteDeps {
  const dir = mkdtempSync(join(tmpdir(), 'career-skills-route-'));
  tempDirs.push(dir);
  return { repos, broadcast: () => undefined, sessionId: () => 'sess-1', exportsDir: dir, llm: null };
}

async function get(deps: CareerRouteDeps, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`http://local${path}`, { method: 'GET' });
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error(`route returned null for GET ${path}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('技能成果的读取接口', () => {
  let repos: Repos;
  let deps: CareerRouteDeps;

  beforeEach(() => {
    repos = createMemoryRepos();
    deps = makeDeps(repos);
  });
  afterEach(() => {
    repos.db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('GET /probe-predictions：interview_predict 写进库的追问预测能读出来（含主简历的，resume_tailored_id 为空）', async () => {
    const at = '2026-11-01T00:00:00.000Z';
    repos.db.insert('probe_prediction', { id: 'prb_1', resume_tailored_id: null, claim_id: null, statement: '提升配置效率 30%', target_type: 'data', expected_chain_json: JSON.stringify(['口径是什么', '怎么统计的']), risk: 'high', created_at: at });
    repos.db.insert('probe_prediction', { id: 'prb_2', resume_tailored_id: null, claim_id: null, statement: '负责积分兑换模块', target_type: 'project', expected_chain_json: JSON.stringify(['你拍板了什么']), risk: 'low', created_at: at });
    const res = await get(deps, '/api/career/probe-predictions');
    expect(res.status).toBe(200);
    const rows = res.json.predictions as Array<{ statement: string; risk: string; expected_chain_json: string; resume_tailored_id: string | null }>;
    expect(rows.map(r => r.statement).sort()).toEqual(['提升配置效率 30%', '负责积分兑换模块'].sort());
    expect(rows.every(r => r.resume_tailored_id === null)).toBe(true);
    expect(JSON.parse(rows.find(r => r.risk === 'high')!.expected_chain_json)).toEqual(['口径是什么', '怎么统计的']);
  });

  it('GET /job-evaluations：只列评估过的岗位，带评分和硬门槛结果，不带 JD 原文', async () => {
    const scored = repos.upsertJob({ source_platform: 'manual', title: '后端开发', company_name: '甲公司', jd_raw: '很长的 JD 原文' });
    repos.upsertJob({ source_platform: 'manual', title: '没评估过的岗位', company_name: '乙公司' });
    repos.db.update('job', scored.id, { score_json: JSON.stringify({ score: { total: 77 }, verdict: 'strong' }), prefilter_json: JSON.stringify({ pass: true }) });

    const res = await get(deps, '/api/career/job-evaluations');
    expect(res.status).toBe(200);
    const rows = res.json.evaluations as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: scored.id, company_name: '甲公司', title: '后端开发' });
    expect(JSON.parse(rows[0].score_json as string)).toMatchObject({ verdict: 'strong' });
    expect(rows[0]).not.toHaveProperty('jd_raw');
  });
});
