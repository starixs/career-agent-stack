import { describe, expect, it } from 'vitest';

import { BATCH_STATE_KEY } from './batch-runner';
import { setJobPrefs } from './job-board';
import { formatMainlineState, readMainlineFacts } from './mainline-state';
import { createMemoryRepos } from './test-db';

const NOW = '2026-11-05T10:00:00.000Z';

function applied(repos: ReturnType<typeof createMemoryRepos>, company: string) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, company_name: company, title: '后端开发', url: `https://${company}.example.com` });
  const app = repos.createApplication(job.id);
  for (const stage of ['ready', 'approved', 'applied'] as const) repos.transition(app.id, stage, '投出', {}, '2026-11-05T09:00:00.000Z');
  return app;
}

describe('mainline state line', () => {
  it('empty library: says there is nothing yet, so the model goes to collect a resume', () => {
    const line = formatMainlineState(readMainlineFacts(createMemoryRepos(), NOW));
    expect(line).toContain('经历 0 段');
    expect(line).toContain('主简历 0 份');
    expect(line).toContain('方向未定');
    expect(line).toContain('近24小时没有投出');
    expect(line).toContain('不要复述给他');
  });

  it('reads experiences, direction, recent sends and background filling', () => {
    const repos = createMemoryRepos();
    repos.createExperience({ title: '食堂点餐小程序', type: 'course_project', role: '前端' });
    setJobPrefs(repos, { keywords: ['后端'], cities: ['北京'] });
    applied(repos, '美团');
    applied(repos, '字节');
    repos.kvSet(BATCH_STATE_KEY, { status: 'running', updatedAt: NOW, done: 2, failed: 0, handoffs: 0, queued: 4, todayCount: 2, running: [{ actionId: 'a', title: 't', host: 'h' }, { actionId: 'b', title: 't', host: 'h2' }] });

    const facts = readMainlineFacts(repos, NOW);
    expect(facts).toMatchObject({ experiences: 1, direction: '后端/北京', filling: 2, queued: 4 });
    expect(facts.sentCompanies.sort()).toEqual(['字节', '美团']);
    expect(formatMainlineState(facts)).toContain('后台在填 2 家、排队 4 家');
  });

  it('stays one short line even with many companies', () => {
    const line = formatMainlineState({ experiences: 5, masterResumes: 2, direction: '产品/上海/杭州', sentCompanies: ['甲', '乙', '丙', '丁', '戊'], filling: 3, queued: 12, asks: 2 });
    expect(line).toContain('近24小时投出 5 家（甲、乙、丙等）');
    expect(line.length).toBeLessThan(140);
  });
});
