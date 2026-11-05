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

describe('岗位池当场收窄', () => {
  it('他说一个方向，符合的数跟着变，条件变成小签', async () => {
    const core = await loadCore();
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, core);
    repos.upsertJob({ source_platform: 'campus', source_job_id: 'a', title: '新媒体运营', company_name: '甲', url: 'https://a.com/1' });
    repos.upsertJob({ source_platform: 'campus', source_job_id: 'b', title: '财务专员', company_name: '乙', url: 'https://b.com/1' });
    expect(railSnapshot(repos, store, core).pool).toEqual({ total: 2, fits: 2, conditions: [] });
    setJobPrefs(repos, { keywords: ['运营'] });
    expect(railSnapshot(repos, store, core).pool).toEqual({ total: 2, fits: 1, conditions: ['运营'] });
  });
});

describe('右栏的网申块说真话', () => {
  it('填表失败不算完成：自动再试时说正在再试一次；再试也没成交给等你，这里不再说、也不说投出 0 份', async () => {
    const core = await loadCore();
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, core);
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'x', title: '产品', company_name: '甲', url: 'https://x.zhiye.com/apply' });
    const app = repos.createApplication(job.id);
    repos.jumpTo(app.id, 'pending');
    const fill = repos.enqueueAction('fill_form', { url: 'https://x.zhiye.com/apply' }, app.id, true);
    repos.setActionStatus(fill.id, 'failed', { error: '浏览器没有返回填表结果' });
    repos.transition(app.id, 'blocked');
    const apply = () => railSnapshot(repos, store, core).blocks.find(b => b.id === 'apply')!;
    expect(core.autoRetryFailedFill(repos, fill.id)).toBe('retrying');
    expect(apply()).toMatchObject({ status: 'working', line: '1 份没填成，正在再试一次', done: 0 });
    repos.setActionStatus(fill.id, 'failed', { error: '浏览器没有返回填表结果' });
    expect(apply()).toMatchObject({ status: 'idle', line: '还没投出', done: 0 });
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

describe('回执里的简历', () => {
  it('回执里定制版不写成主简历名', async () => {
    const core = await loadCore();
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, core);
    const master = store.createResumeMaster({ name: '小林的简历', schema_json: { skills: ['SQL'] } });
    const submitWith = (company: string, resumeId: string, kind: 'master' | 'tailored', answers?: unknown) => {
      const app = applied(repos, company, '数据分析');
      const packet = repos.createPacket({ application_id: app.id, job_id: repos.getApplication(app.id)!.job_id, resume_id: resumeId, resume_kind: kind, answers });
      const action = repos.enqueueAction('submit', { packet_id: packet.id, summary: { filled: 20 } }, app.id);
      repos.setActionStatus(action.id, 'done', {});
    };
    submitWith('京东', master.id, 'master');
    const t = store.createTailored({ master_id: master.id, job_id: null, schema_json: master.schema_json });
    store.confirmTailored(t.id, { skills: ['SQL', 'Hive', 'AB 实验'] });
    submitWith('美团', t.id, 'tailored', { resume_plan: { kind: 'tailored', changes: 6 } });
    submitWith('滴滴', t.id, 'tailored');
    const byCompany = Object.fromEntries(railSnapshot(repos, store, core).receipts.map(r => [r.company, r]));
    expect(byCompany['京东']).toMatchObject({ resume: '小林的简历', resume_kind: 'master', changes: null, filled: 20 });
    expect(byCompany['美团']).toMatchObject({ resume_kind: 'tailored', changes: 6 });
    // 老材料包没记改动数：现算（相对生成时的主简历加了两项）
    expect(byCompany['滴滴']).toMatchObject({ resume_kind: 'tailored', changes: 2 });
  });

  it('定制块：按岗位改了几份、今天几份', async () => {
    const core = await loadCore();
    const repos = createMemoryRepos();
    const store = new CareerStore(repos, core);
    const master = store.createResumeMaster({ name: '小林的简历' });
    store.createTailored({ master_id: master.id, schema_json: {} });
    store.createTailored({ master_id: master.id, schema_json: {} });
    repos.db.run("UPDATE resume_tailored SET created_at='2020-01-01T00:00:00.000Z' WHERE rowid=1");
    expect(railSnapshot(repos, store, core).blocks.find(b => b.id === 'tailor')?.line).toBe('按岗位改了 2 份 · 今天 1');
  });
});
