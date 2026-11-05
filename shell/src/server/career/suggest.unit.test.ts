/**
 * 下一步条端到端（plan-r3-suggest §5 G1）：≥15 幕的夹具出四格（模型 mock），断言文字、mode 序列、do 的动作、过前端校验；
 * 模型超时 / 出错 → 兜底 ≥2 格且有能办的；模型出开发词 / 撞卡按钮 / 没对象的被丢。
 * 状态用纯对象夹具（状态从哪来见 suggest-state.unit.test.ts）。
 */
import type { LLM } from '@career/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSuggest, SUGGEST_MAX_CHARS, type SuggestChip, type SuggestRequest } from '../../shared/careerSuggest';
import { prePick } from './batch-propose';
import { buildSuggestions, resetSuggestMemory, SUGGEST_LLM_TIMEOUT_MS, suggestFor } from './suggest';
import { guideFor } from './suggest-recipes';
import { ask, card, interviewing, jobs, state } from './suggest-fixtures';
import { resetExitRotation } from './suggest-seeds';
import { namesPhrase, shortCompany } from './suggest-text';
import type { SuggestState } from './suggest-types';

/** 模型按紧凑行回：[文字, intent?, target?]（mode 由服务端推）。 */
const llmReturning = (chips: Array<{ text: string; intent?: string; target?: string }>): LLM => {
  const c = chips.map(({ text, intent, target }) => (target ? [text, intent ?? 'say', target] : intent ? [text, intent] : [text]));
  return { complete: vi.fn(async () => ({ text: JSON.stringify({ c }), usage: { input_tokens: 1, output_tokens: 1 } })) };
};
const texts = (chips: SuggestChip[]) => chips.map(c => c.text);
const modes = (chips: SuggestChip[]) => chips.map(c => c.mode);
const starts = (chips: SuggestChip[]) => chips.filter(c => c.action?.type === 'start_feature');

/** 每条都要守的：2–4 格、≤22 字、过前端校验原样保留、≤1 退出口。 */
function wellFormed(chips: SuggestChip[]): void {
  expect(chips.length).toBeGreaterThanOrEqual(2);
  expect(chips.length).toBeLessThanOrEqual(4);
  expect(chips.every(c => c.text.length <= SUGGEST_MAX_CHARS)).toBe(true);
  expect(parseSuggest({ chips })).toEqual(chips);
  expect(chips.filter(c => c.mode === 'exit').length).toBeLessThanOrEqual(1);
}

async function bar(s: SuggestState, req: SuggestRequest, llm: LLM | null = null) {
  const res = await suggestFor(s, req, llm);
  wellFormed(res.chips);
  return res;
}

describe('下一步条 · 按幕出四格', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  it('S1 冷启动：有 / 没有简历、邮箱接手投、届别填空', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, prefs: { keywords: [], cities: [], cohort: null }, mailConnected: false });
    const { chips, scene } = await bar(s, { last_user: '你好', last_assistant: '手上有简历吗？' });
    expect(scene).toBe('S1');
    expect(texts(chips)).toEqual(['有简历，我拖进来', '还没有，先聊聊', '我是 ＿＿ 届，找校招', '手投过的从邮箱接过来']);
    expect(modes(chips)).toEqual(['answer', 'answer', 'option', 'start']);
    expect(chips[3].action).toEqual({ type: 'start_feature', feature_id: 'mail_bind' });
  });

  it('S3 访谈·开放问：模型按经历类型替他组织三种说法 + 先跳过', async () => {
    const llm = llmReturning([{ text: '是几个人一组的课程作业' }, { text: '老师布置的数据库大作业' }, { text: '我也不太清楚' }]);
    const { chips, scene } = await bar(interviewing(), { last_assistant: '这个课程项目做的是什么？' }, llm);
    expect(scene).toBe('S3');
    expect(texts(chips)).toEqual(['是几个人一组的课程作业', '老师布置的数据库大作业', '老师布置的期末大作业', '这段先跳过，聊别的']);
    expect(modes(chips)).toEqual(['option', 'option', 'option', 'exit']);
  });

  it('S3 模型超时：按课程项目这一类给兜底说法', async () => {
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = suggestFor(interviewing(), { last_assistant: '这个课程项目做的是什么？' }, llm);
    await vi.advanceTimersByTimeAsync(SUGGEST_LLM_TIMEOUT_MS + 10);
    const { chips } = await pending;
    vi.useRealTimers();
    wellFormed(chips);
    expect(texts(chips)).toEqual(['是几个人一组的课程作业', '老师布置的期末大作业', '自己做的小东西，没人布置', '这段先跳过，聊别的']);
  });

  it('S4 追数字：也叫模型；模型给的格没点到这一轮就丢，兜底是带单位的半句', async () => {
    const llm = llmReturning([{ text: '这句和这一轮无关' }]);
    const { chips } = await bar(interviewing(), { last_assistant: '大概有多少人参加？' }, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(texts(chips)).toEqual(['大概 ＿＿ 人参加：', '做了约 ＿＿ 周：', '没统计过，只能估个大概', '这个数记不清了，先跳过']);
    expect(chips.slice(0, 2).every(c => c.kind === 'fill')).toBe(true);
  });

  it('S5 降级问：更小的场景，真没有就换下一类', async () => {
    const { chips, scene } = await bar(interviewing(), { last_user: '没做过啥项目', last_assistant: '那有没有帮社团做过事？' });
    expect(scene).toBe('S5');
    expect(texts(chips)).toEqual(['真没有，换下一类', '家教、兼职算吗', '帮社团或家里做过事', '报过名没获奖的比赛']);
    expect(modes(chips).every(m => m === 'option')).toBe(true);
  });

  it('S6 一轮聊完：接着说下一类、补一点、出简历、先聊到这', async () => {
    const s = interviewing({ inProgress: false, round: null, followUps: [], roundsTodo: ['internship'] }, { resume: { has: false, name: null, tailored: 0, experiences: 2 } });
    const { chips } = await bar(s, { last_assistant: '这段差不多了。', last_tools: ['experience_interview'] });
    expect(texts(chips)).toEqual(['接着说实习', '直接出一版简历看看', '刚那段还有一点：', '今天先聊到这，明天接着']);
    expect(modes(chips)).toEqual(['advance', 'advance', 'option', 'exit']);
  });

  it('S6 已有简历时不出"直接出一版简历看看"（兜底也不补）', async () => {
    const s = interviewing({ inProgress: false, round: null, followUps: [], roundsTodo: ['internship'] }, { resume: { has: true, name: '财务版', tailored: 0, experiences: 3 } });
    const { chips } = await bar(s, { last_assistant: '这段差不多了。', last_tools: ['experience_interview'] });
    expect(texts(chips)).not.toContain('直接出一版简历看看');
  });

  it('S26 攒简历期：兜底按阶段给，不出查公司 / 评估岗位', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, mailConnected: true });
    const { chips, scene } = await bar(s, { last_user: '你还能帮我做什么？' });
    expect(scene).toBe('S26');
    // 本幕兜底只有两格：用通用兜底补到第三格（不到四格时补位）
    expect(texts(chips)).toEqual(['有简历，我拖进来', '先口述一段实习', '我想问点别的：']);
    const noMail = await bar({ ...s, mailConnected: false }, { last_user: '你还能帮我做什么？' });
    expect(texts(noMail.chips)).toContain('手投过的从邮箱接过来');
  });

  it('S8 方向提议：模型给同意 / 只要一类，规则收城市、再加一类', async () => {
    const llm = llmReturning([{ text: '行，就财务、运营这两类' }, { text: '只投财务' }]);
    const s = state({ stage: 'direction', prefs: { keywords: [], cities: ['北京', '上海'], cohort: '2027' } });
    const { chips } = await bar(s, { last_assistant: '先投财务、运营这两类，行吗？' }, llm);
    expect(texts(chips)).toEqual(['行，就财务、运营这两类', '只投财务', '再加一类：', '先按这几类挑几家看看']);
    expect(chips[3].action).toEqual({ type: 'propose_batch' });
  });

  it('S9 方向咨询：替他说出在意什么 + 两类都投几家（do）', async () => {
    const llm = llmReturning([{ text: '我更想要稳定的财务' }, { text: '运营以后好跨行吗' }, { text: '帮我登录一下' }]);
    const { chips, scene } = await bar(state({ stage: 'direction' }), { last_user: '财务好还是运营好？' }, llm);
    expect(scene).toBe('S9');
    expect(texts(chips)).toEqual(['我更想要稳定的财务', '运营以后好跨行吗', '我更想稳定一点', '财务、运营都先投几家看看']);
    expect(chips[3].action).toEqual({ type: 'propose_batch' });
  });

  it('S10 JD 评估：投这家、查这家公司（点名）、看差距、看下一个', async () => {
    const s = state({ nextJobs: jobs('平安银行') });
    const { chips } = await bar(s, { last_assistant: '平安银行这个岗位匹配度 72。', last_tools: ['job_evaluate'] });
    expect(texts(chips)).toEqual(['投这家，按它改简历', '先看我差在哪几条', '不投了，看下一个', '先看平安银行靠谱吗']);
    expect(starts(chips)[0].action).toEqual({ type: 'start_feature', feature_id: 'company_research', args: { company: '平安银行' } });
  });

  it('S13 勾选表：卡幕也叫模型；模型格被丢时兜底就这 5 家 / 全投 / 换一批 / 放着', async () => {
    const llm = llmReturning([{ text: '这句和这一轮无关' }]);
    const s = state({ openCard: card({ id: 'batch-pick:1', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1', 'j2', 'j3', 'j4', 'j5'], allIds: Array.from({ length: 18 }, (_, i) => `j${i + 1}`) }) });
    const { chips } = await bar(s, { last_assistant: '先投这 5 家？' }, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(texts(chips)).toEqual(['就这 5 家', '全投，18 家都投', '换一批', '这批先放着，我去忙']);
    expect(chips[0].action).toEqual({ type: 'start_card', card_id: 'batch-pick:1', job_ids: ['j1', 'j2', 'j3', 'j4', 'j5'] });
    expect(chips[3]).toMatchObject({ mode: 'exit', action: { type: 'dismiss_card', card_id: 'batch-pick:1' } });
  });

  it('S14 批量进行中：备好的都投出、看在填的那份、连手机、先去忙', async () => {
    const s = state({
      batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 4, queued: 8 },
      held: { count: 3, companies: ['美的'], askId: 'ask-review' }, phoneLinked: false,
      asks: [ask({ id: 'ask-review', kind: 'review', count: 3 }), ask({ id: 'ask-login', kind: 'login', companies: ['华为'] })],
    });
    const { chips, scene } = await bar(s, {}, null);
    expect(scene).toBe('S15');
    const running = await bar({ ...s, asks: [s.asks[0]] }, {});
    expect(running.scene).toBe('S18');
    resetSuggestMemory(); // 上两次出过"看招商那份"，L12 会挡掉；这里看的是 S14 本身的兜底
    const plain = await bar({ ...s, asks: [] }, {});
    expect(plain.scene).toBe('S14');
    // 开现场与起头「网申进展」同落点，只留一格（L8），起头换成下一个
    expect(texts(plain.chips)).toEqual(['把招商银行那份给我看看', '查一家公司靠不靠谱', '我想问点别的：', '我先去忙，你接着投']);
    expect(chips.some(c => c.text === '连上手机自动收验证码')).toBe(true);
  });

  it('S16 缺信息：填一次整批放行、空着、先不填、隐私', async () => {
    const s = state({ asks: [ask({ kind: 'info', title: '证件号码', count: 20 })] });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toEqual(['填证件号码，20 家一起放行', '这项我没有，空着', '这批先不填证件号码', '我的身份证号安全吗']);
    expect(chips[0].action).toEqual({ type: 'open_deck', ask_id: 'ask-info' });
  });

  it('S19 等你选：选项原文摆成格', async () => {
    const s = state({ asks: [ask({ kind: 'choice', title: '是否接受调剂' })], askOptions: { 'ask-choice': ['接受调剂', '不接受'] } });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toEqual(['选「接受调剂」', '选「不接受」', '按最常见的选', '先看题是什么']);
    expect(chips[3].action).toEqual({ type: 'open_deck', ask_id: 'ask-choice' });
    expect(chips[0].action).toEqual({ type: 'ask_choose', ask_id: 'ask-choice', choice: '接受调剂' });
    expect(chips[1].action).toEqual({ type: 'ask_choose', ask_id: 'ask-choice', choice: '不接受' });
  });

  it('S20 笔试：搜题直接起头（每轮 1 个），练题、往年题点名公司', async () => {
    const s = state({ dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-06' }], nextJobs: jobs('平安') });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toEqual(['考试时截图给你搜题', '先练几道字节跳动的题', '字节跳动往年考什么', '考完跟你说结果']);
    expect(starts(chips)).toHaveLength(1);
    expect(chips[0].action).toEqual({ type: 'start_feature', feature_id: 'exam_search' });
  });

  it('S21 面试准备：准备这场（带公司）、深挖、模拟、复盘', async () => {
    const s = state({ dueSoon: [{ kind: 'interview', company: '字节跳动', at: '2026-11-06' }] });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toEqual(['帮我准备字节跳动这场面试', '字节跳动会深挖我简历哪里', '来一遍模拟面试', '面完我来复盘']);
    expect(chips[0].action).toEqual({ type: 'start_feature', feature_id: 'interview_prep', args: { company: '字节跳动' } });
  });

  it('S22 面后复盘：推导三格 + 下一场怎么改', async () => {
    const { chips } = await bar(state(), { last_user: '今天面完了，感觉一般' });
    expect(texts(chips)).toEqual(['先说最卡的那题', '问了什么我记不全了', '面试官当时反应：', '下一场怎么改']);
  });

  it('S24 低谷：看数、换方向、歇两天、接着投（do）', async () => {
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_user: '是不是我不行啊' });
    expect(texts(chips)).toEqual(['看我这个月的数', '换个方向试试', '先不投了，歇两天', '接着投，别管了']);
    expect(chips[3].action).toEqual({ type: 'propose_batch' });
  });

  it('低谷叠加：别的幕里把一格换成"看我这个月的数"，卡在等时不动', async () => {
    const s = state({ rejections7d: 6, asks: [ask({ kind: 'failed', count: 3 })] });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toContain('看我这个月的数');
    expect(texts(chips)).toContain('再试一次这 3 家');
    const pick = state({ rejections7d: 6, openCard: card({ kind: 'batch_pick', pickedIds: ['j1'], allIds: ['j1'] }) });
    expect(texts((await bar(pick, {})).chips)).not.toContain('看我这个月的数');
  });

  it('S27 隔几天回来：从最急的开始、看开放题、投出几家、稍后', async () => {
    const s = state({ asks: [ask({ kind: 'review', count: 3 }), ask({ id: 'oq', kind: 'info', title: '开放题 2 道' })] });
    const { chips, scene } = await bar(s, { away_hours: 30 });
    expect(scene).toBe('S27');
    expect(texts(chips)).toEqual(['从最急的开始', '先看开放题写了什么', '这几天投出了几家', '我先忙，等下处理']);
    expect(chips[1].action).toEqual({ type: 'open_deck', ask_id: 'oq' });
  });

  it('S29 兜底：下一批（do）、一个起头、模型接一句；问句时保底有回应格', async () => {
    const llm = llmReturning([{ text: '平安那份我先看看' }]);
    const s = state({ nextJobs: jobs('平安', '美的') });
    const { chips, scene } = await bar(s, { last_assistant: '要不要先看看平安？' }, llm);
    expect(scene).toBe('S29');
    // 出勾选表与起头「批量投递」同落点（L8），第三格换成查公司
    expect(texts(chips)).toEqual(['平安那份我先看看', '先投平安、美的这 2 家', '先看平安靠谱吗', '我想问点别的：']);
    expect(modes(chips)).toEqual(['answer', 'advance', 'start', 'option']);
    const noModel = await bar(s, { last_assistant: '要不要先看看平安？' }, null);
    expect(noModel.chips.some(c => c.mode === 'answer' || c.mode === 'option')).toBe(true);
    expect(noModel.chips.some(c => c.kind === 'do')).toBe(true);
  });

  it('S29 过线后不到四格时用 S26 按阶段的起头补满（真机 r2：S29 只剩两格）', async () => {
    const llm = llmReturning([{ text: '后端名额缩了？那我还投吗' }, { text: '大厂现在还招后端吗' }]);
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 1 }, mailConnected: false });
    const { chips, scene } = await bar(s, { last_user: '大厂现在还招后端吗', last_assistant: '后端名额缩了一些，但还在招。' }, llm);
    expect(scene).toBe('S29');
    expect(chips).toHaveLength(4);
    expect(texts(chips)).not.toContain('大厂现在还招后端吗');
  });

  it('模型出错不抛；开发词 / 撞卡按钮 / 没对象的格被丢', async () => {
    const boom: LLM = { complete: vi.fn(async () => { throw new Error('boom'); }) };
    const err = await bar(state({ nextJobs: jobs('平安') }), { last_assistant: '好的' }, boom);
    expect(err.chips.some(c => c.kind === 'do')).toBe(true);
    const bad = llmReturning([{ text: '用这个工具登录' }, { text: '我也不太清楚' }, { text: '这是一句明显超过二十二个字上限的很长很长很长的回复' }]);
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_assistant: '好的' }, bad);
    expect(texts(chips).some(t => /工具|不太清楚|很长/.test(t))).toBe(false);
  });

  it('规则层 < 50ms；离开时长以请求为准', async () => {
    const s = state({ asks: [ask({ kind: 'failed', count: 3 }), ask({ kind: 'review', id: 'r', count: 2 })], nextJobs: jobs('平安') });
    const t0 = performance.now();
    const res = await suggestFor(s, { away_hours: 1 }, null);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(res.scene).toBe('S17');
    expect((await suggestFor({ ...s, awayHours: 50 }, { away_hours: 1 }, null)).scene).toBe('S17');
    expect((await suggestFor(s, { away_hours: 20 }, null)).scene).toBe('S27');
  });

  it('旧接口 buildSuggestions 仍只返回格子', async () => {
    const chips = await buildSuggestions(state({ nextJobs: jobs('平安') }), {}, null);
    wellFormed(chips);
  });
});

/** 回声模型：从 user 提示词里读"这一轮"，把他说的、小芽说的拼进四格（真模型会这样随上下文变）。 */
function echoLlm(): LLM {
  return {
    complete: vi.fn(async (req: { messages: Array<{ content: string }> }) => {
      const prompt = req.messages[0]?.content ?? '';
      const u = /他说「([^」]*)」/.exec(prompt)?.[1] ?? '';
      const a = /小芽说「([^」]*)」/.exec(prompt)?.[1] ?? '';
      const c = [[`${u.slice(0, 8)}，就这样`], [`${u.slice(0, 6)}，大概 ＿＿ 个：`, 'fill'], [`${a.slice(0, 8)}，然后呢`], ['先投下一批', 'propose_batch', 'next']];
      return { text: JSON.stringify({ c }), usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  };
}

const turn = (user: string, assistant: string, tools: string[] = [], cards: string[] = []): SuggestRequest =>
  ({ this_turn: { user, assistant, tools, cards } });

const SAME_SCENE_CASES: ReadonlyArray<{ scene: string; s: SuggestState; a: SuggestRequest; b: SuggestRequest }> = [
  { scene: 'S1', s: state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 } }),
    a: turn('我是会计专业的大三学生', '手上有简历吗？'), b: turn('之前投了很多都没回音', '想找什么方向？') },
  { scene: 'S4', s: interviewing(), a: turn('我们做了一个选课系统', '大概有多少人参加？'), b: turn('那次比赛是学校组织的', '大概有多少人参加？') },
  { scene: 'S10', s: state({ nextJobs: jobs('平安银行') }), a: turn('平安这个岗位怎么样', '匹配度 72，差两条。', ['job_evaluate']), b: turn('帮我看看这个财务岗', '匹配度 55，缺证书。', ['job_evaluate']) },
  { scene: 'S13', s: state({ openCard: card({ id: 'bp', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1'], allIds: ['j1', 'j2'] }) }),
    a: turn('外包的我都不要', '挑了 5 家，先投这些？', [], ['batch_pick']), b: turn('只想投上海的岗位', '挑了 3 家，先投这些？', [], ['batch_pick']) },
  { scene: 'S14', s: state({ batch: { status: 'running', running: ['招商银行'], runningAppId: 'a1', done: 2, queued: 5 } }),
    a: turn('现在投到哪一家了', '正在填招商银行。'), b: turn('我晚上再来看结果', '好，我接着填。') },
  { scene: 'S20', s: state({ dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-07', daysLeft: 2 }] }),
    a: turn('字节笔试考些什么', '一般考行测和专业题。'), b: turn('我有点怕考不好', '后天就考，先练几道。') },
  { scene: 'S22', s: state(), a: turn('今天面完了感觉一般', '哪题最卡？'), b: turn('刚面完群面没说上话', '群面谁主导的？') },
  { scene: 'S24', s: state({ nextJobs: jobs('平安') }), a: turn('是不是我不行啊又被拒', '这周拒信多是常态。'), b: turn('投了没用不想投了', '先歇一下也行。') },
];

describe('真跑回归（11-05）', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  it('开场两扇门还在（还没说过话）：条上不重复门上的话，给门给不了的', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, prefs: { keywords: [], cities: [], cohort: null }, mailConnected: false });
    const { chips, scene } = await bar(s, {});
    expect(scene).toBe('S1');
    expect(chips).toHaveLength(4);
    const t = texts(chips);
    expect(t.some(x => x.includes('有简历') || x === '还没有，先聊聊')).toBe(false);
    expect(t).toEqual(expect.arrayContaining(['我是 ＿＿ 届，找校招', '手投过的从邮箱接过来', '我做过的一件事是：']));
  });

  it('门还在时模型 / 示例写了门上的话也被 L5 挡下', async () => {
    const llm = llmReturning([{ text: '有简历，我拖进来' }, { text: '还没有，先聊聊' }, { text: '我是 ＿＿ 届，找校招', intent: 'fill' }]);
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, mailConnected: false });
    const { chips } = await bar(s, { turns: [{ role: 'assistant', text: '你手上有简历吗？' }] }, llm);
    expect(texts(chips).some(x => x.includes('有简历') || x === '还没有，先聊聊')).toBe(false);
  });

  it('过线后不到四格时补到四格（本幕示例的说 / 填空，再通用兜底）', async () => {
    const s = state({
      batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 4, queued: 8 },
      held: { count: 3, companies: ['美的'], askId: 'ask-review' }, phoneLinked: false,
    });
    const { chips, scene } = await bar(s, {});
    expect(scene).toBe('S14');
    expect(chips).toHaveLength(4);
  });
});

describe('r4 · 模型优先：同幕不同上下文出不同格', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  for (const c of SAME_SCENE_CASES) {
    it(`${c.scene}：两轮说的不一样，四格就不一样，且点到这一轮的话`, async () => {
      const llm = echoLlm();
      const ra = await bar(c.s, c.a, llm);
      const rb = await bar(c.s, c.b, llm);
      expect([ra.scene, rb.scene]).toEqual([c.scene, c.scene]);
      expect(llm.complete).toHaveBeenCalledTimes(2);
      expect(texts(ra.chips)).not.toEqual(texts(rb.chips));
      expect(texts(ra.chips).some(t => t.includes(c.a.this_turn?.user.slice(0, 6) ?? '?'))).toBe(true);
      expect(texts(rb.chips).some(t => t.includes(c.b.this_turn?.user.slice(0, 6) ?? '?'))).toBe(true);
    });
  }

  it('卡幕：模型没写出卡的主动作时从兜底补"就这 N 家"', async () => {
    const c = SAME_SCENE_CASES[3];
    const { chips } = await bar(c.s, c.a, echoLlm());
    expect(chips.some(ch => ch.action?.type === 'start_card')).toBe(true);
  });

  it('模型拿到这一幕的思路与这一轮', async () => {
    const llm = echoLlm();
    await suggestFor(SAME_SCENE_CASES[3].s, SAME_SCENE_CASES[3].a, llm);
    const arg = vi.mocked(llm.complete).mock.calls[0]?.[0];
    expect(arg?.system).toContain(guideFor('S13')?.text ?? '?');
    expect(arg?.messages[0]?.content).toContain('外包的我都不要');
  });

  it('意图换成真 id；换不出的丢', async () => {
    const llm = llmReturning([
      { text: '先投平安、美的', intent: 'propose_batch', target: '平安、美的' },
      { text: '查查腾讯靠谱吗', intent: 'start_feature', target: 'nope_feature' },
    ]);
    const { chips } = await bar(state({ nextJobs: jobs('平安', '美的') }), turn('平安和美的先投吧', '好的。'), llm);
    expect(chips.find(c => c.text === '先投平安、美的')?.action).toEqual({ type: 'propose_batch', job_ids: ['job-0', 'job-1'] });
    expect(texts(chips)).not.toContain('查查腾讯靠谱吗');
  });

  it('L12：下一轮不和上一轮出过的重样', async () => {
    const llm = llmReturning([{ text: '平安那份我先看看', intent: 'say' }, { text: '平安面试什么时候', intent: 'say' }]);
    const s = state({ nextJobs: jobs('平安') });
    const first = await bar(s, turn('平安怎么样', '平安还在等。'), llm);
    const second = await suggestFor(s, turn('平安怎么样', '平安还在等。'), llm);
    expect(texts(first.chips)).toContain('平安那份我先看看');
    expect(texts(second.chips)).not.toContain('平安那份我先看看');
  });

  it('P1-2 loose 幕（S5 替他说处境）跳过 L11：本轮没提"家教"的模型格也留；strict 幕（S3）同一句被丢', async () => {
    const llm = () => llmReturning([{ text: '做过家教，算吗' }]);
    const loose = await bar(interviewing(), { this_turn: { user: '没做过啥项目', assistant: '那有没有帮社团做过事？', tools: [], cards: [] } }, llm());
    expect(loose.scene).toBe('S5');
    expect(texts(loose.chips)).toContain('做过家教，算吗');
    resetSuggestMemory();
    const strict = await bar(interviewing(), { this_turn: { user: '', assistant: '这个课程项目做的是什么？', tools: [], cards: [] } }, llm());
    expect(strict.scene).toBe('S3');
    expect(texts(strict.chips)).not.toContain('做过家教，算吗');
  });

  it('stale 结果（钩子超时 / 被新一轮顶掉）不记上一轮，下一轮不会因 L12 少格', async () => {
    const llm = llmReturning([{ text: '平安那份我先看看' }, { text: '平安面试什么时候' }]);
    const s = state({ nextJobs: jobs('平安') });
    await suggestFor(s, turn('平安怎么样', '平安还在等。'), llm, { isStale: () => true });
    const next = await suggestFor(s, turn('平安怎么样', '平安还在等。'), llm);
    expect(texts(next.chips)).toContain('平安那份我先看看');
  });

  it('日志锚点：[career-suggest] model ms= chips= degraded=', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await bar(state({ nextJobs: jobs('平安') }), turn('平安怎么样', '平安还在等。'), echoLlm());
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[career-suggest\] model ms=\d+ chips=4 degraded=false scene=S\d+$/));
    log.mockRestore();
  });

  it('L13：模型四格全是 say 时换一格能办的进来', async () => {
    const llm = llmReturning(['平安一', '平安二', '平安三', '平安四'].map(t => ({ text: `${t}再看看`, intent: 'say' })));
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), turn('平安怎么样', '平安还在等。'), llm);
    expect(new Set(chips.map(c => c.kind)).size).toBeGreaterThan(1);
  });

  it('兜底：模型超时 3s → 旧配方 ≥2 格含能办的，degraded', async () => {
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = suggestFor(state({ nextJobs: jobs('平安') }), turn('平安怎么样', '平安还在等。'), llm);
    await vi.advanceTimersByTimeAsync(3_000 + 10);
    const res = await pending;
    vi.useRealTimers();
    expect(SUGGEST_LLM_TIMEOUT_MS).toBe(3_000);
    wellFormed(res.chips);
    expect(res.chips.some(c => c.kind === 'do')).toBe(true);
    expect(res.degraded).toBe(true);
  });

  it('兜底：模型 8 条全换不出 → 旧配方，degraded；正常时 degraded=false', async () => {
    const bad = llmReturning(Array.from({ length: 8 }, (_, i) => ({ text: `去第${i}个地方`, intent: 'open', target: 'nowhere' })));
    const s = state({ nextJobs: jobs('平安') });
    const res = await bar(s, turn('平安怎么样', '平安还在等。'), bad);
    expect(res.degraded).toBe(true);
    expect(res.chips.some(c => c.kind === 'do')).toBe(true);
    resetSuggestMemory();
    expect((await bar(s, turn('平安怎么样', '平安还在等。'), echoLlm())).degraded).toBe(false);
  });
});

describe('字面规则', () => {
  it('公司名超过 6 字截断、最多点两家', () => {
    expect(shortCompany('华为技术有限公司')).toBe('华为技术');
    expect(shortCompany('宁德时代新能源科技股份有限公司')).toBe('宁德时代新…');
    expect(namesPhrase(['招商银行', '平安', '美的', '格力'], 5)).toBe('招商银行、平安等 5 家');
  });

  it('一家公司只勾一个岗，勾满为止', () => {
    const rows = prePick([{ company: '招商银行' }, { company: '招商银行' }, { company: '平安' }, { company: '美的' }], 2);
    expect(rows.map(r => r.picked)).toEqual([true, false, true, false]);
  });
});
