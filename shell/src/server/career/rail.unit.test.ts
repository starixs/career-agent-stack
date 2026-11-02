/**
 * 右栏读模型 + 信任账本：实例 A（小林，没简历）从建档一路走到放手，右栏每一步说的是不是真话。
 */
import { describe, expect, it } from 'vitest';

import { loadCore } from './core-module';
import { setJobPrefs } from './job-board';
import { railSnapshot } from './rail';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';
import { delegate, needsFaceToFace, recordSuccess, revoke, trustOf } from './trust-ledger';

const BEISEN = { key: 'system:beisen', label: '北森' };

function applied(repos: ReturnType<typeof createMemoryRepos>, company: string, title: string) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `${company}-${title}`, company_name: company, title, url: `https://${company}.zhiye.com/campus` });
  const app = repos.createApplication(job.id);
  for (const stage of ['ready', 'approved', 'applied'] as const) repos.transition(app.id, stage, '投出');
  return app;
}

describe('右栏读模型', () => {
  it('小林：没简历时停在建档；有了经历要定方向；投出第一份前是当面投；之后一小批，盖章后放手', async () => {
    const core = await loadCore();
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, core);
    expect(railSnapshot(repos, store, core).stage).toBe('profile');
    expect(railSnapshot(repos, store, core).blocks.map(b => b.label)).toEqual(['写简历', '定制', '网申', '盯邮箱']);

    repos.createExperience({ title: '食堂点餐小程序', type: 'course_project', role: '前端' });
    expect(railSnapshot(repos, store, core).stage).toBe('profile');
    store.createResumeMaster({ name: '小林的简历' });
    expect(railSnapshot(repos, store, core).stage).toBe('direction');

    setJobPrefs(repos, { keywords: ['财务分析'] });
    expect(railSnapshot(repos, store, core).stage).toBe('first');

    applied(repos, '招商银行', '财务管培');
    const snap = railSnapshot(repos, store, core);
    expect(snap.stage).toBe('batch');
    expect(snap.receipts).toEqual([expect.objectContaining({ company: '招商银行', title: '财务管培' })]);
    expect(snap.today.sent).toBe(1);

    recordSuccess(repos, BEISEN);
    recordSuccess(repos, BEISEN);
    expect(railSnapshot(repos, store, core).learned).toEqual([expect.objectContaining({ label: '北森', state: 'shown', propose: true })]);
    delegate(repos, BEISEN.key);
    expect(railSnapshot(repos, store, core).stage).toBe('released');
  });
});

describe('信任账本', () => {
  it('当面做通才到 shown；只有盖章才到 delegated；收回后下一份又当面', () => {
    const repos = createMemoryRepos();
    expect(trustOf(repos, BEISEN.key)).toBe('new');
    expect(needsFaceToFace(repos, BEISEN.key, null, false)).toBe(true);
    recordSuccess(repos, BEISEN);
    expect(trustOf(repos, BEISEN.key)).toBe('shown');
    expect(needsFaceToFace(repos, BEISEN.key, null, false)).toBe(true);
    delegate(repos, BEISEN.key);
    expect(needsFaceToFace(repos, BEISEN.key, null, false)).toBe(false);
    // 标星公司在已放权的系统上，没单独放权前照样当面
    expect(needsFaceToFace(repos, BEISEN.key, '字节跳动', true)).toBe(true);
    revoke(repos, BEISEN.key);
    expect(trustOf(repos, BEISEN.key)).toBe('shown');
  });

  it('没见过的类不能盖章', () => {
    expect(delegate(createMemoryRepos(), 'system:moka')).toBeNull();
  });
});
