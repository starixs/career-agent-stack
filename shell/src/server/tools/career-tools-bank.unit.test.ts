import { beforeEach, describe, expect, it, vi } from 'vitest';

// 题库工具：出题 / 复盘 / 笔试练习进题库，作答记录与趋势；以及 auto 模式与岗位汇总工具。
// SDK 的 tool() 被替换成注册表，直接调用 handler；模型用 FakeLLM；数据层用内存 SQLite。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => {
    mocks.handlers.set(name, handler);
    return { name };
  }),
}));

vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { ...res, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

/** 轻量 schema：只保证各分区是数组、basics 是对象（真实实现在 @career/resume，这里不拉 react-pdf）。 */
const parseResume = (input: unknown) => {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(r[k]) ? r[k] : []);
  return { version: 1, basics: { ...(r.basics as Record<string, unknown> | undefined ?? {}) }, education: arr('education'), experience: arr('experience'), projects: arr('projects'), skills: arr('skills'), awards: arr('awards'), certifications: arr('certifications'), custom_sections: arr('custom_sections') } as never;
};

describe('career 题库与岗位工具', () => {
  let llm: FakeLLM;
  let repos: ReturnType<typeof createMemoryRepos>;

  beforeEach(async () => {
    mocks.handlers.clear();
    llm = new FakeLLM();
    repos = createMemoryRepos();
    await createCareerServer({ repos, llm, broadcast: () => {}, sessionId: () => 'sess-1', resumeModule: async () => ({ parseResume }) });
  });

  it('按 JD 出的题进题库；真实面试里被问到同一题时升级为"我见过的"', async () => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '产品经理', company_name: '甲公司', jd_raw: '负责需求分析' });
    llm.push(JSON.stringify({ questions: [{ type: 'project', question: '讲一个你做需求分析的例子', probe_points: ['用户是谁'], difficulty: 'medium', jd_requirement: '需求分析' }] }));
    const gen = (await call('interview_questions', { job_id: job.id })).json() as { questions: Array<{ question_id: string }> };
    const qid = gen.questions[0].question_id;
    expect(repos.getQuestion(qid)).toMatchObject({ source: 'generated', job_id: job.id, category: 'project' });

    llm.push(JSON.stringify({ questions: [{ type: 'project', quote: '讲一个你做需求分析的例子。' }, { type: 'reverse', quote: '你有什么想问我的' }] }));
    const retro = (await call('interview_retro', { transcript: '…', company_name: '甲公司' })).json();
    expect(retro.questions_saved).toBe(2);
    expect(repos.getQuestion(qid)).toMatchObject({ source: 'seen', seen_count: 1 });

    const a1 = (await call('question_attempt', { question_id: qid, answer_text: '第一次', score: 40 })).json();
    const a2 = (await call('question_attempt', { question_id: qid, answer_text: '第二次', score: 75 })).json();
    expect(a1.trend).toBeNull();
    expect(a2).toMatchObject({ history: [40, 75], trend: 35 });
    const bank = (await call('question_bank', { source: 'seen' })).json() as { questions: Array<{ id: string; last_score: number }> };
    expect(bank.questions.find(q => q.id === qid)!.last_score).toBe(75);
  });

  it('笔试练习：题目进题库，批改结果按题记作答', async () => {
    const created = (await call('exam_practice', { title: '行测', kind: '行测', questions: [{ q: '1+1=?', reference: '2' }, { q: '2+2=?', reference: '4' }], seen: true })).json();
    await call('exam_practice', { exam_id: created.exam_id, answers: [{ index: 0, answer: '2' }, { index: 1, answer: '5' }] });
    await call('exam_practice', { exam_id: created.exam_id, review: [{ index: 0, verdict: '对' }, { index: 1, verdict: '错', comment: '粗心' }], finish: true });
    const qs = repos.listQuestions({ kind: 'written' });
    expect(qs).toHaveLength(2);
    expect(qs.every(q => q.source === 'seen')).toBe(true);
    const byContent = new Map(qs.map(q => [q.content, q]));
    expect(byContent.get('1+1=?')!.last_attempt_score).toBe(100);
    expect(byContent.get('2+2=?')!.last_attempt_score).toBe(0);
  });

  it('question_add 只记原题；auto 模式工具可查可切换', async () => {
    const res = (await call('question_add', { questions: [{ content: '为什么想来我们公司' }], company_name: '乙' })).json() as { saved: Array<{ id: string }> };
    expect(repos.getQuestion(res.saved[0].id)).toMatchObject({ content: '为什么想来我们公司', source: 'seen', company_name: '乙' });
    expect((await call('apply_auto_mode', {})).json()).toMatchObject({ auto_mode: false, learn_threshold: 3 });
    expect((await call('apply_auto_mode', { enabled: true })).json()).toMatchObject({ auto_mode: true });
  });

  it('job_prefs 设置后重算匹配；jobs_board 只给可解释结果', async () => {
    const exp = repos.createExperience({ title: '数据实习', org: '某厂' });
    const c = repos.addClaim({ experience_id: exp.id, text: '用 SQL 做留存分析' }); repos.confirmClaim(c.id);
    repos.upsertJob({ source_platform: 'manual', title: '数据分析实习生', company_name: '丙', location: '上海', jd_raw: '熟练 SQL', employment_type: 'intern', cohort: '2027届' });
    repos.upsertJob({ source_platform: 'manual', title: '数据分析（2026届）', company_name: '丁', location: '上海', jd_raw: '熟练 SQL', employment_type: 'campus', cohort: '2026届' });
    await call('job_prefs', { cohort: '2027届', cities: ['上海'] });
    const board = (await call('jobs_board', { fits_only: true })).json() as { rows: Array<{ company: string; fits: boolean; covered: string[] }> };
    expect(board.rows.map(r => r.company)).toEqual(['丙']);
    expect(board.rows[0].covered[0]).toMatch(/SQL ← 某厂 · 数据实习/);
  });
});
