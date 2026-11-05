/**
 * 下一步条的状态从哪来（plan-r2 §B.2）：全是本地查询——勾选表卡、批量运行器、停在提交前的提交、
 * 方向内下一批（和勾选表同一个来源）、手机绑定、离开几小时；接上建议条后点名真实公司。
 */
import { describe, expect, it } from 'vitest';

import { PHONE_KV_KEY } from '../../shared/careerPhone';
import { BATCH_PICK_CARD_KIND } from './batch-propose';
import { BATCH_STATE_KEY } from './batch-runner';
import { loadCore } from './core-module';
import { setJobPrefs } from './job-board';
import { CareerStore } from './store';
import { buildSuggestions, resetSuggestMemory } from './suggest';
import { suggestStateOf } from './suggest-context';
import { createMemoryRepos } from './test-db';

const core = await loadCore();
const NOW = new Date('2026-11-05T15:00:00');
const HOURS_AWAY = 30;

function setup() {
  const repos = createMemoryRepos();
  const store = new CareerStore(repos, core);
  const session = repos.createSession('助理').id;
  const job = (company: string, title: string) =>
    repos.upsertJob({ source_platform: 'campus', source_job_id: `${company}-${title}`, title, company_name: company, url: `https://jobs.${company}.test/${title}` });
  return { repos, store, session, job };
}

describe('下一步条的状态', () => {
  it('没简历、没会话：阶段 profile，什么都不等他', () => {
    const { repos, store } = setup();
    const s = suggestStateOf(repos, store, { sessionId: null, now: NOW });
    expect(s.stage).toBe('profile');
    expect(s.resume.has).toBe(false);
    expect(s.openCard).toBeNull();
    expect(s.awayHours).toBeNull();
    expect(s.hour).toBe(15);
    expect(s.cohortGuess).toBe(2027);
  });

  it('方向内下一批和勾选表同一个来源，带真实公司名', () => {
    const { repos, store, job } = setup();
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    setJobPrefs(repos, { keywords: ['财务'], cities: ['上海'], cohort: '2027' });
    job('招商银行', '财务分析'); job('平安', '财务管培'); job('某某人力外包', '财务助理'); job('美的', '运营助理');
    const s = suggestStateOf(repos, store, { sessionId: null, now: NOW });
    expect(s.stage).toBe('first');
    expect(s.nextJobs.map(j => j.company).sort()).toEqual(['平安', '招商银行', '某某人力外包']);
    expect(s.pool.fits).toBe(3);
    expect(s.pool.outsourced).toBe(1);
    expect(s.prefs).toEqual({ keywords: ['财务'], cities: ['上海'], cohort: '2027' });
  });

  it('底下的勾选表：默认勾的公司和岗位 id 从卡上读', () => {
    const { repos, store, session } = setup();
    repos.upsertChatCard({ id: 'batch-pick:1', session_id: session, kind: BATCH_PICK_CARD_KIND, title: '先投这 2 家？', data: {
      rows: [{ job_id: 'j1', company: '招商银行', picked: true }, { job_id: 'j2', company: '平安', picked: true }, { job_id: 'j3', company: '美的', picked: false }], more: 4,
    } });
    const s = suggestStateOf(repos, store, { sessionId: session, now: NOW });
    expect(s.openCard).toMatchObject({ id: 'batch-pick:1', picked: ['招商银行', '平安'], pickedIds: ['j1', 'j2'], allIds: ['j1', 'j2', 'j3'], more: 4 });
  });

  it('定制卡：公司、岗位、改了几处', () => {
    const { repos, store, session } = setup();
    repos.upsertChatCard({ id: 'tailor:t1', session_id: session, kind: 'tailor_diff', title: '定制好了', data: { tailored_id: 't1', master_id: 'm', job_id: 'jm', company: '美团', title: '运营', total: 6 } });
    const s = suggestStateOf(repos, store, { sessionId: session, now: NOW });
    expect(s.lastTailor).toEqual({ card_id: 'tailor:t1', company: '美团', job_id: 'jm', tailored_id: 't1', changes: 6 });
  });

  it('批量在填谁、停在提交前几份：从运行器状态和待审提交读，点名公司', async () => {
    const { repos, store, job } = setup();
    store.createResumeMaster({ name: '财务版', schema_json: { basics: {} } });
    const cmb = repos.createApplication(job('招商银行', '财务分析').id);
    const fill = repos.enqueueAction('fill_form', {}, cmb.id);
    const pingan = repos.createApplication(job('平安', '财务管培').id);
    repos.enqueueAction('submit', {}, pingan.id);
    repos.kvSet(BATCH_STATE_KEY, { status: 'running', updatedAt: NOW.toISOString(), running: [{ actionId: fill.id, title: '网申填表', host: 'x' }], done: 4, failed: 0, handoffs: 0, queued: 8, todayCount: 4 });
    const s = suggestStateOf(repos, store, { sessionId: null, now: NOW });
    expect(s.batch).toMatchObject({ status: 'running', running: ['招商银行'], runningAppId: cmb.id, done: 4, queued: 8 });
    expect(s.held).toMatchObject({ count: 1, companies: ['平安'] });
    resetSuggestMemory();
    const chips = await buildSuggestions(s, {}, null);
    expect(chips.find(c => c.action?.type === 'open' && c.action.surface === 'live')?.text).toBe('把招商银行那份给我看看');
    expect(chips.find(c => c.slot === 'exit')?.text).toBe('我先去忙，你接着投');
  });

  it('访谈进度：只有当前轮 in_progress 才算在访谈里；三天内截止点名公司', () => {
    const { repos, store, job } = setup();
    const exp = repos.createExperience({ title: '数据库课设', type: 'course_project' });
    repos.kvSet(core.INTERVIEW_STATE_KEY, { rounds: { education: 'done', course_project: 'in_progress' }, current_round: 'course_project', current_experience_id: exp.id, follow_up_questions: ['几个人一组？'] });
    const app = repos.createApplication(job('字节跳动', '运营').id);
    repos.createDeadline({ kind: 'written_test', title: '字节笔试', due_at: new Date(NOW.getTime() + 86_400_000).toISOString(), application_id: app.id });
    repos.createDeadline({ kind: 'interview', title: '远的面试', due_at: new Date(NOW.getTime() + 10 * 86_400_000).toISOString() });
    const s = suggestStateOf(repos, store, { sessionId: null, now: NOW });
    expect(s.interview).toMatchObject({ round: 'course_project', inProgress: true, experienceTitle: '数据库课设', followUps: ['几个人一组？'] });
    expect(s.interview?.roundsTodo).not.toContain('course_project');
    expect(s.dueSoon).toEqual([expect.objectContaining({ kind: 'written_test', company: '字节跳动' })]);
    expect(s.rejections7d).toBe(0);
    repos.kvSet(core.INTERVIEW_STATE_KEY, { rounds: { course_project: 'done' }, current_round: 'course_project', follow_up_questions: ['旧的'] });
    expect(suggestStateOf(repos, store, { sessionId: null, now: NOW }).interview).toMatchObject({ inProgress: false, followUps: [] });
  });

  it('手机绑定与离开几小时', () => {
    const { repos, store, session } = setup();
    repos.kvSet(PHONE_KV_KEY, { address: 'aa:bb', name: '小米', bound_at: NOW.toISOString() });
    const at = new Date(NOW.getTime() - HOURS_AWAY * 3_600_000).toISOString();
    repos.db.insert('message', { id: 'm1', session_id: session, role: 'user', content_json: '"hi"', created_at: at });
    const s = suggestStateOf(repos, store, { sessionId: session, now: NOW });
    expect(s.phoneLinked).toBe(true);
    expect(s.awayHours).toBeCloseTo(HOURS_AWAY, 5);
  });
});
