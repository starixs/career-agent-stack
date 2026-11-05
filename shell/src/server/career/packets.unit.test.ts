/**
 * 材料包与「用哪份简历」：真 JD 才定制、定制版数清改了几处、PDF 导不出来 / 简历上还留着私密库占位符的那家不开始。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCore } from './core-module';
import { prepareJobs } from './job-board';
import { countResumeChanges, hasRealJd, missingVaultFields, resumePlanForJob, resumeStepMessage, saveCapturedJd } from './packets';
import { CareerStore } from './store';
import { tailorJobs } from './tailor-for-job';
import { createMemoryRepos } from './test-db';

const REAL_JD = '岗位职责：负责经营数据分析。任职要求：熟练 SQL。';
const CAMPUS_META = `公司：招商银行\n行业：金融\n批次：正式批\n岗位：${'管培生、'.repeat(60)}\n网申链接：https://cmb.com/1`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-packets-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, await loadCore());
  const exportPdf = async (id: string) => { const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${id}`); return p; };
  return { repos, store, deps: { repos, store, exportPdf, exportsDir: dir } };
}

describe('hasRealJd / resumePlanForJob', () => {
  it('campus 元数据不算 JD', () => {
    expect(CAMPUS_META.length).toBeGreaterThan(200);
    expect(hasRealJd({ jd_raw: CAMPUS_META })).toBe(false);
    expect(hasRealJd({ jd_raw: '' })).toBe(false);
    expect(hasRealJd({ jd_raw: null })).toBe(false);
    expect(hasRealJd({ jd_raw: '后端开发' })).toBe(false);
    expect(hasRealJd({ jd_raw: REAL_JD })).toBe(true);
    expect(hasRealJd({ jd_raw: '我们在找一位后端同学。'.repeat(30) })).toBe(true);
  });

  it('有定制版 → tailored 并数改动；有真 JD 没定制 → will_tailor；没 JD → no_jd（主简历）', async () => {
    const { repos, store } = await setup();
    const master = store.createResumeMaster({ name: '通用版', schema_json: { basics: { name: '小林' }, skills: ['SQL'], experience: [{ org: '某电商', bullets: ['做留存分析'] }] } });
    const withJd = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '京东', url: 'https://jd.com/1', jd_raw: REAL_JD });
    const campus = repos.upsertJob({ source_platform: 'campus', title: '管培', company_name: '招行', url: 'https://cmb.com/1', jd_raw: CAMPUS_META });
    expect(resumePlanForJob(store, repos, withJd.id)).toEqual({ kind: 'will_tailor', resume_id: master.id, name: '通用版', changes: null });
    expect(resumePlanForJob(store, repos, campus.id)).toEqual({ kind: 'no_jd', resume_id: master.id, name: '通用版', changes: null });
    const t = store.createTailored({ master_id: master.id, job_id: withJd.id, schema_json: master.schema_json });
    store.confirmTailored(t.id, { basics: { name: '小林' }, skills: ['SQL', 'AB 实验'], experience: [{ org: '某电商', bullets: ['用 SQL 做留存分析'] }] });
    // 改了一条经历、加了一项技能 = 2 处；之后主简历再改不影响这个数（基准是生成时的快照）
    store.saveResume(master.id, { basics: { name: '小林' }, skills: [] });
    expect(resumePlanForJob(store, repos, withJd.id)).toEqual({ kind: 'tailored', resume_id: t.id, name: '通用版', changes: 2 });
  });

  it('好几份主简历又没选：resume_id 为空；选了就用选的那份', async () => {
    const { repos, store } = await setup();
    store.createResumeMaster({ name: '财务版' });
    const b = store.createResumeMaster({ name: '数据版' });
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '京东', url: 'https://jd.com/1' });
    expect(resumePlanForJob(store, repos, job.id)).toMatchObject({ kind: 'no_jd', resume_id: null, name: null });
    expect(resumePlanForJob(store, repos, job.id, b.id)).toMatchObject({ kind: 'no_jd', resume_id: b.id, name: '数据版' });
  });

  it('countResumeChanges 数加、删、改的文字', () => {
    expect(countResumeChanges({ a: ['x', 'y'] }, { a: ['x', 'y'] })).toBe(0);
    expect(countResumeChanges({ a: ['x', 'y'] }, { a: ['x', 'z', 'w'] })).toBe(2);
    expect(countResumeChanges({ a: ['x', 'y'] }, { a: ['x'] })).toBe(1);
  });
});

describe('批量开始前的闸', () => {
  it('占位符没解开的不冻结：说清缺哪一项，不建投递', async () => {
    const { repos, store, deps } = await setup();
    store.createResumeMaster({ name: '通用版', schema_json: { basics: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}' } } });
    const job = repos.upsertJob({ source_platform: 'manual', title: '后端', company_name: '京东', url: 'https://jd.com/1' });
    const vaultUnresolved = (text: string) => (text.includes('{{vault:profile.phone}}') ? ['{{vault:profile.phone}}'] : []);
    const [r] = await prepareJobs({ ...deps, vaultUnresolved }, [job.id]);
    expect(r).toMatchObject({ ok: false, reason: '简历里缺 手机号' });
    expect(repos.listApplications()).toHaveLength(0);
    expect(repos.listActions()).toHaveLength(0);
    expect(missingVaultFields('{"x":"{{vault:exp.exp_1.org}}"}', () => ['{{vault:exp.exp_1.org}}'])).toEqual(['经历里的信息']);
  });
});

describe('定制超时', () => {
  it('超时的退回、出错的退回；从不抛错', async () => {
    const runner = async ({ jobId }: { jobId: string }) => {
      if (jobId === 'slow') return new Promise<never>(() => undefined);
      if (jobId === 'bad') throw new Error('boom');
      return { tailored_id: `t-${jobId}`, changes: 3 };
    };
    const out = await tailorJobs(runner, [{ jobId: 'ok', masterId: 'm' }, { jobId: 'slow', masterId: 'm' }, { jobId: 'bad', masterId: 'm' }], { timeoutMs: 20, concurrency: 1 });
    expect(out.get('ok')).toEqual({ ok: true, tailored_id: 't-ok', changes: 3 });
    expect(out.get('slow')).toEqual({ ok: false, reason: 'tailor_timeout' });
    expect(out.get('bad')).toEqual({ ok: false, reason: 'tailor_failed' });
  });
});

describe('投的时候说实话', () => {
  it('网申进展第一步：定制版说改了几处，没 JD 直说用主简历，定制没成直说', () => {
    expect(resumeStepMessage({ kind: 'no_jd', changes: null })).toBe('用主简历（没拿到岗位描述）');
    expect(resumeStepMessage({ kind: 'tailored', changes: 6 })).toBe('定制简历 ✓ 改 6 处');
    expect(resumeStepMessage({ kind: 'master', changes: null, reason: 'tailor_timeout' })).toBe('用主简历（这次定制没成）');
    expect(resumeStepMessage(undefined)).toBeNull();
  });

  it('填表时读到的岗位描述：只在没有真 JD 时存，并清掉旧解析；读到的不像 JD 不存', async () => {
    const { repos } = await setup();
    const campus = repos.upsertJob({ source_platform: 'campus', title: '管培', company_name: '招行', url: 'https://cmb.com/1', jd_raw: CAMPUS_META, jd_parsed_json: '{"title":"旧"}' });
    const real = repos.upsertJob({ source_platform: 'manual', title: '后端', company_name: '京东', url: 'https://jd.com/1', jd_raw: REAL_JD });
    expect(saveCapturedJd(repos, campus.id, '首页 登录 注册')).toBe(false);
    expect(saveCapturedJd(repos, campus.id, `管培生 ${REAL_JD}`)).toBe(true);
    expect(repos.getJob(campus.id)).toMatchObject({ jd_raw: `管培生 ${REAL_JD}`, jd_parsed_json: null });
    expect(saveCapturedJd(repos, real.id, `别的 ${REAL_JD}`)).toBe(false);
    expect(repos.getJob(real.id)!.jd_raw).toBe(REAL_JD);
  });
});
