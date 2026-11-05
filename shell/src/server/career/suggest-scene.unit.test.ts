/**
 * 判幕（plan-r3-suggest §2）：29 幕每幕至少一个夹具判中；多幕叠加按优先级（卡 > 问句 > 等你 > 访谈 > 截止 > 阶段 > 兜底）。
 */
import { describe, expect, it } from 'vitest';

import type { SuggestRequest } from '../../shared/careerSuggest';
import { ask, card, input, interview, interviewing, jobs, state } from './suggest-fixtures';
import { classifyScene, SCENES, type SceneId } from './suggest-scene';
import type { SuggestState } from './suggest-types';

const pick = card({ kind: 'batch_pick', pickedIds: ['j1'], allIds: ['j1', 'j2'] });
const tailorCard = card({ id: 'tc', kind: 'tailor_diff' });
const tailor = { card_id: 'tc', company: '美团', job_id: 'j', tailored_id: 't', changes: 3 };
const running = { status: 'running' as const, running: ['招商银行'], runningAppId: 'a1', done: 0, queued: 3 };
const noResume = { has: false, name: null, tailored: 0, experiences: 0 };

const CASES: ReadonlyArray<[SceneId, Partial<SuggestState> | SuggestState, SuggestRequest]> = [
  ['S1', { stage: 'profile', resume: noResume }, { last_assistant: '手上有简历吗？' }],
  ['S2', { stage: 'direction' }, { last_assistant: '入学写 2023.09 还是 2023.08？', last_tools: ['resume_import'] }],
  ['S3', interviewing(), { last_assistant: '这个课程项目做的是什么？' }],
  ['S4', interviewing(), { last_assistant: '大概有多少人参加？' }],
  ['S5', interviewing(), { last_user: '没做过啥项目', last_assistant: '那有没有帮社团做过事？' }],
  ['S6', interviewing({ inProgress: false, round: null, followUps: [] }), { last_assistant: '这段差不多了，接着说实习。', last_tools: ['experience_interview'] }],
  ['S7', { openCard: card({ kind: 'claims_confirm' }) }, { last_assistant: '这几条对吗？' }],
  ['S8', { stage: 'direction' }, { last_assistant: '先投财务、运营这两类，行吗？' }],
  ['S9', { stage: 'direction' }, { last_user: '财务好还是运营好？' }],
  ['S10', { nextJobs: jobs('平安') }, { last_assistant: '匹配度 72。', last_tools: ['job_evaluate'] }],
  ['S11', { openCard: tailorCard, lastTailor: tailor }, {}],
  ['S12', { stage: 'first', batch: running, nextJobs: jobs('平安') }, {}],
  ['S13', { openCard: pick }, {}],
  ['S14', { batch: running, nextJobs: jobs('平安') }, {}],
  ['S15', { asks: [ask({ kind: 'login', companies: ['华为'] })] }, {}],
  ['S16', { asks: [ask({ kind: 'info', title: '证件号码', count: 20 })] }, {}],
  ['S17', { asks: [ask({ kind: 'failed', count: 3 })] }, {}],
  ['S18', { asks: [ask({ kind: 'review', count: 3 })] }, {}],
  ['S19', { asks: [ask({ kind: 'choice' })], askOptions: { 'ask-choice': ['是', '否'] } }, {}],
  ['S20', { dueSoon: [{ kind: 'written_test', company: '字节', at: '2026-11-06T10:00:00Z' }], nextJobs: jobs('平安') }, {}],
  ['S21', { dueSoon: [{ kind: 'interview', company: '字节', at: '2026-11-06T10:00:00Z' }], nextJobs: jobs('平安') }, {}],
  ['S22', { nextJobs: jobs('平安') }, { last_user: '今天面完了，感觉一般' }],
  ['S23', { nextJobs: jobs('平安') }, { last_user: '拿到两个 offer 了，选哪个' }],
  ['S24', { nextJobs: jobs('平安') }, { last_user: '是不是我不行啊' }],
  ['S25', { nextJobs: jobs('平安') }, { last_user: '字节泡了 20 天还有戏吗？' }],
  ['S26', { nextJobs: jobs('平安') }, { last_user: '你还能帮我做什么？' }],
  ['S27', { awayHours: 30, asks: [ask({ kind: 'review', count: 3 }), ask({ kind: 'login', id: 'l' })] }, {}],
  ['S28', { stage: 'released', nextJobs: [] }, {}],
  ['S29', { nextJobs: jobs('平安') }, { last_assistant: '好的。' }],
];

const sceneOf = (s: Partial<SuggestState> | SuggestState, req: SuggestRequest) => classifyScene(state(s), input(req));

describe('判幕', () => {
  it.each(CASES)('%s 判中', (scene, s, req) => {
    expect(sceneOf(s, req).scene).toBe(scene);
  });

  it('29 幕全覆盖', () => {
    expect(new Set(CASES.map(c => c[0]))).toEqual(new Set(SCENES));
  });

  it('卡 > 问句 > 等你 > 访谈 > 截止 > 阶段', () => {
    const due = [{ kind: 'interview', company: '字节', at: '2026-11-06T10:00:00Z' }];
    const loginAsk = [ask({ kind: 'login' })];
    expect(sceneOf({ openCard: pick, asks: loginAsk }, { last_user: '你还能帮我做什么？' }).scene).toBe('S13');
    expect(sceneOf({ asks: loginAsk, nextJobs: jobs('平安') }, { last_user: '你还能帮我做什么？' }).scene).toBe('S26');
    expect(sceneOf(interviewing({}, { asks: loginAsk }), { last_assistant: '做的是什么？' }).scene).toBe('S15');
    expect(sceneOf(interviewing({}, { dueSoon: due }), { last_assistant: '做的是什么？' }).scene).toBe('S3');
    expect(sceneOf({ dueSoon: due, batch: running }, {}).scene).toBe('S21');
  });

  it('旧 kv 残留（当前轮不是 in_progress）不算在访谈里', () => {
    const stale = interviewing({ inProgress: false, round: 'course_project', followUps: ['几个人？'] }, { resume: { has: true, name: 'x', tailored: 0, experiences: 3 }, stage: 'batch', nextJobs: jobs('平安') });
    expect(sceneOf(stale, { last_assistant: '好的。' }).scene).toBe('S29');
  });

  it('stale interview kv in batch stage does not produce interview chips', () => {
    const stale = state({ stage: 'batch', nextJobs: jobs('平安'), interview: interview() });
    expect(['S3', 'S4', 'S5', 'S6']).not.toContain(sceneOf(stale, {}).scene);
    expect(['S3', 'S4', 'S5', 'S6']).not.toContain(sceneOf(stale, { last_assistant: '好的。', last_tools: ['experience_interview'] }).scene);
    expect(sceneOf(stale, { last_user: '招商银行那份投出去了吗？' }).scene).toBe('S25');
  });

  it('多个等你：登录优先；离开 12 小时以上是"回来"', () => {
    const asks = [ask({ kind: 'review', count: 2 }), ask({ kind: 'login', id: 'l' })];
    expect(sceneOf({ asks }, {}).scene).toBe('S15');
    expect(sceneOf({ asks, awayHours: 13 }, {}).scene).toBe('S27');
  });

  it('近 7 天拒信多：不抢幕，只打低谷标记；兜底时整幕是 S24', () => {
    expect(sceneOf({ rejections7d: 6, openCard: pick }, {})).toEqual({ scene: 'S13', low: true });
    expect(sceneOf({ rejections7d: 6, nextJobs: jobs('平安') }, {})).toEqual({ scene: 'S24', low: false });
  });

  it('turns 里取最后一句；工具名只留小写下划线', () => {
    const x = input({ turns: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '手上有简历吗？' }], last_tools: ['resume_import', 'mcp__x__Bad'] });
    expect(x.lastAssistant).toBe('手上有简历吗？');
    expect(x.lastTools).toEqual(['resume_import']);
  });
});
