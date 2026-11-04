/**
 * review_queue 的每一条只回精简视图（2026-11-05：原样吐整条记录，几十条就超出工具输出上限，助理只能去翻落盘文件）。
 */
import { describe, expect, it } from 'vitest';

import { createMemoryRepos } from '../career/test-db';
import { reviewRow } from './career-tools';

describe('reviewRow', () => {
  it('公司、岗位、状态、出错原因、网申域名；不带 payload / result 全文', () => {
    const repos = createMemoryRepos();
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '数据分析师', company_name: '美图公司' });
    const app = repos.createApplication(job.id);
    const a = repos.enqueueAction('fill_form', { url: 'https://hr.meitu.com/jobCampus/abc', packet_id: 'pkt_x', long: 'x'.repeat(5000) }, app.id, true);
    repos.setActionStatus(a.id, 'failed', { error: 'BROWSER_PREPARATION_FAILED（HTTP 500）' });
    const row = reviewRow(repos, repos.getAction(a.id)!);
    expect(row).toMatchObject({ company: '美图公司', title: '数据分析师', status: 'failed', host: 'hr.meitu.com', result: 'BROWSER_PREPARATION_FAILED（HTTP 500）' });
    expect(JSON.stringify(row).length).toBeLessThan(600);
  });
});
