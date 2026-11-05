/**
 * 下一步条端到端：≥15 幕的夹具出一行三条（配合 / 犹豫 / 纠正各一条，模型 mock），断言每个立场位的文字、do 的动作、过前端校验；
 * 模型超时 / 出错 → 兜底仍是三条；模型出开发词 / 撞卡按钮 / 没对象的被丢后由示例、配方、立场兜底补位。
 * 状态用纯对象夹具（状态从哪来见 suggest-state.unit.test.ts）。
 */
import type { LLM } from '@career/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseSuggest, SUGGEST_MAX_CHARS, SUGGEST_STANCES, type SuggestChip, type SuggestRequest, type SuggestStance,
} from '../../shared/careerSuggest';
import { prePick } from './batch-propose';
import { buildSuggestions, resetSuggestMemory, SUGGEST_LLM_TIMEOUT_MS, suggestFor } from './suggest';
import { guideFor } from './suggest-recipes';
import { ask, card, interviewing, jobs, state } from './suggest-fixtures';
import { askNext, resetExitRotation } from './suggest-seeds';
import { namesPhrase, shortCompany } from './suggest-text';
import type { SuggestAsk, SuggestState } from './suggest-types';

type Row = { text: string; intent?: string; target?: string };
const rowOf = ({ text, intent, target }: Row) => (target ? [text, intent ?? 'say', target] : intent ? [text, intent] : [text]);
const reply = (out: unknown) => ({ text: JSON.stringify(out), usage: { input_tokens: 1, output_tokens: 1 } });

/** 旧格式：模型按紧凑行回 {"c":[[文字, intent?, target?]]}，不带立场（服务端按 stanceOf 归位，仍兼容）。 */
const llmReturning = (chips: Row[]): LLM => ({ complete: vi.fn(async () => reply({ c: chips.map(rowOf) })) });

const STANCE_KEY: Readonly<Record<SuggestStance, string>> = { agree: '配合', hesitate: '犹豫', correct: '纠正' };
/** 现格式：模型按立场分组回 {"配合":[[…],…],"犹豫":…,"纠正":…}，每种立场 ≤2 条备选。 */
const llmByStance = (by: Partial<Record<SuggestStance, Row[]>>): LLM => {
  const out = Object.fromEntries(SUGGEST_STANCES.flatMap(st => (by[st] ? [[STANCE_KEY[st], by[st].map(rowOf)]] : [])));
  return { complete: vi.fn(async () => reply(out)) };
};

const texts = (chips: SuggestChip[]) => chips.map(c => c.text);
const starts = (chips: SuggestChip[]) => chips.filter(c => c.action?.type === 'start_feature');
const at = (chips: SuggestChip[], st: SuggestStance) => chips.find(c => c.stance === st);

/** 每条都要守的：1–3 条、≤22 字、过前端校验原样保留、每条带立场、按配合 → 犹豫 → 纠正排且不重复。 */
function wellFormed(chips: SuggestChip[]): void {
  expect(chips.length).toBeGreaterThanOrEqual(1);
  expect(chips.length).toBeLessThanOrEqual(3);
  expect(chips.every(c => c.text.length <= SUGGEST_MAX_CHARS)).toBe(true);
  expect(parseSuggest({ chips })).toEqual(chips);
  const stances = chips.map(c => c.stance);
  expect(stances.every(st => st !== undefined)).toBe(true);
  expect(stances).toEqual(SUGGEST_STANCES.filter(st => stances.includes(st)));
}

async function bar(s: SuggestState, req: SuggestRequest, llm: LLM | null = null) {
  const res = await suggestFor(s, req, llm);
  wellFormed(res.chips);
  expect(res.chips).toHaveLength(3);
  return res;
}

describe('下一步条 · 按幕出三条（配合 / 犹豫 / 纠正）', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  it('S1 冷启动：配合位回简历有无，犹豫 / 纠正位用本幕示例', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, prefs: { keywords: [], cities: [], cohort: null }, mailConnected: false });
    const { chips, scene } = await bar(s, { last_user: '你好', last_assistant: '手上有简历吗？' });
    expect(scene).toBe('S1');
    expect(texts(chips)).toEqual(['有简历，我拖进来', '还没想好方向，先聊聊', '不找实习，我找校招']);
  });

  it('S3 访谈·开放问：模型按立场替他组织说法；含糊的被丢，由退出口补到犹豫位', async () => {
    const llm = llmByStance({
      agree: [{ text: '是几个人一组的课程作业' }, { text: '老师布置的数据库大作业' }],
      hesitate: [{ text: '我也不太清楚' }],
      correct: [{ text: '不是作业，是自己做的小东西' }],
    });
    const { chips, scene } = await bar(interviewing(), { last_assistant: '这个课程项目做的是什么？' }, llm);
    expect(scene).toBe('S3');
    expect(texts(chips)).toEqual(['是几个人一组的课程作业', '这段先跳过，聊别的', '不是作业，是自己做的小东西']);
    expect(at(chips, 'hesitate')?.mode).toBe('exit');
  });

  it('S3 模型超时：按课程项目这一类给兜底说法，跳过落在犹豫位', async () => {
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = suggestFor(interviewing(), { last_assistant: '这个课程项目做的是什么？' }, llm);
    await vi.advanceTimersByTimeAsync(SUGGEST_LLM_TIMEOUT_MS + 10);
    const { chips, degraded } = await pending;
    vi.useRealTimers();
    wellFormed(chips);
    expect(degraded).toBe(true);
    // 纠正位用填空让他自己说，不替他编分工
    expect(texts(chips)).toEqual(['是几个人一组的课程作业', '这段先跳过，聊别的', '其实我主要做的是：']);
  });

  it('S4 追数字：也叫模型；没点到这一轮的格被丢，配合位是带单位的半句、犹豫位是跳过', async () => {
    const llm = llmByStance({ agree: [{ text: '这句和这一轮无关' }] });
    const { chips } = await bar(interviewing(), { last_assistant: '大概有多少人参加？' }, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(texts(chips)).toEqual(['大概 ＿＿ 人参加：', '这个数记不清了，先跳过', '不是这样，其实是：']);
    expect(at(chips, 'agree')?.kind).toBe('fill');
  });

  it('S5 降级问：更小的场景，真没有就换下一类', async () => {
    const { chips, scene } = await bar(interviewing(), { last_user: '没做过啥项目', last_assistant: '那有没有帮社团做过事？' });
    expect(scene).toBe('S5');
    expect(texts(chips)).toEqual(['真没有，换下一类', '家教、兼职算吗', '比赛真没有，聊实习吧']);
    expect(chips.every(c => c.mode === 'option')).toBe(true);
  });

  it('S6 一轮聊完：接着说下一类、先聊到这（犹豫）、补一点（纠正）', async () => {
    const s = interviewing({ inProgress: false, round: null, followUps: [], roundsTodo: ['internship'] }, { resume: { has: false, name: null, tailored: 0, experiences: 2 } });
    const { chips } = await bar(s, { last_assistant: '这段差不多了。', last_tools: ['experience_interview'] });
    expect(texts(chips)).toEqual(['接着说实习', '今天先聊到这，明天接着', '课设还有一点没说：']);
    expect(chips.map(c => c.mode)).toEqual(['advance', 'exit', 'option']);
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
    expect(texts(chips)).toEqual(['有简历，我拖进来', '先口述一段实习', '不是这样，其实是：']);
    const noFeature = (c: SuggestChip) => c.action?.type !== 'start_feature' || !['company_research', 'job_evaluate'].includes(c.action.feature_id);
    expect(chips.every(noFeature)).toBe(true);
  });

  it('S8 方向提议：模型按立场给同意 / 担心 / 改一类', async () => {
    const llm = llmByStance({
      agree: [{ text: '行，就财务、运营这两类' }],
      hesitate: [{ text: '运营我真能做吗' }],
      correct: [{ text: '只投财务，运营不要' }],
    });
    const s = state({ stage: 'direction', prefs: { keywords: [], cities: ['北京', '上海'], cohort: '2027' } });
    const { chips, degraded } = await bar(s, { last_assistant: '先投财务、运营这两类，行吗？' }, llm);
    expect(texts(chips)).toEqual(['行，就财务、运营这两类', '运营我真能做吗', '只投财务，运营不要']);
    expect(degraded).toBe(false);
  });

  it('S9 方向咨询：替他说出在意什么；没对象的"帮我登录一下"被丢、纠正位补上', async () => {
    const llm = llmByStance({
      agree: [{ text: '我更想要稳定的财务' }],
      hesitate: [{ text: '运营以后好跨行吗' }],
      correct: [{ text: '帮我登录一下' }],
    });
    const { chips, scene } = await bar(state({ stage: 'direction' }), { last_user: '财务好还是运营好？' }, llm);
    expect(scene).toBe('S9');
    expect(texts(chips).slice(0, 2)).toEqual(['我更想要稳定的财务', '运营以后好跨行吗']);
    expect(texts(chips)).not.toContain('帮我登录一下');
  });

  it('S10 JD 评估：没模型时配合位"投这家"；模型给的查这家公司换成带公司名的起头', async () => {
    const s = state({ nextJobs: jobs('平安银行') });
    const req = { last_assistant: '平安银行这个岗位匹配度 72。', last_tools: ['job_evaluate'] };
    const plain = await bar(s, req);
    expect(at(plain.chips, 'agree')?.text).toBe('投这家，按它改简历');
    resetSuggestMemory();
    const llm = llmByStance({
      agree: [{ text: '投这家，按它改简历', intent: 'propose_batch', target: '平安银行' }],
      hesitate: [{ text: '先看平安银行靠谱吗', intent: 'start_feature', target: 'company_research:平安银行' }],
      correct: [{ text: '平安银行那条我其实会' }],
    });
    const { chips } = await bar(s, req, llm);
    expect(at(chips, 'hesitate')?.action).toEqual({ type: 'start_feature', feature_id: 'company_research', args: { company: '平安银行' } });
  });

  it('S13 勾选表：卡幕也叫模型；配合位永远是卡的主动作（就这 5 家），犹豫位放着', async () => {
    const llm = llmByStance({ agree: [{ text: '这句和这一轮无关' }] });
    const s = state({ openCard: card({ id: 'batch-pick:1', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1', 'j2', 'j3', 'j4', 'j5'], allIds: Array.from({ length: 18 }, (_, i) => `j${i + 1}`) }) });
    const { chips } = await bar(s, { last_assistant: '先投这 5 家？' }, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    // 配方里的「换一批」按文字判成纠正，不再落到立场兜底
    expect(texts(chips)).toEqual(['就这 5 家', '这批先放着，我去忙', '换一批']);
    expect(at(chips, 'agree')?.action).toEqual({ type: 'start_card', card_id: 'batch-pick:1', job_ids: ['j1', 'j2', 'j3', 'j4', 'j5'] });
    expect(at(chips, 'hesitate')).toMatchObject({ mode: 'exit', action: { type: 'dismiss_card', card_id: 'batch-pick:1' } });
  });

  it('S13 模型配合位写了句普通的话，卡的主动作仍排在配合位', async () => {
    const llm = llmByStance({ agree: [{ text: '先投招商银行这几家' }], correct: [{ text: '招商银行不要，换一批' }] });
    const s = state({ openCard: card({ id: 'batch-pick:1', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1'], allIds: ['j1', 'j2'] }) });
    const { chips } = await bar(s, { last_assistant: '先投招商银行？' }, llm);
    expect(at(chips, 'agree')?.action?.type).toBe('start_card');
  });

  it('S14 批量进行中：登录在等（S15）先处理登录；过目在等（S18）都投出；只在填时看在填的那份', async () => {
    const s = state({
      batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 4, queued: 8 },
      held: { count: 3, companies: ['美的'], askId: 'ask-review' }, phoneLinked: false,
      asks: [ask({ id: 'ask-review', kind: 'review', count: 3 }), ask({ id: 'ask-login', kind: 'login', companies: ['华为'] })],
    });
    const login = await bar(s, {}, null);
    expect(login.scene).toBe('S15');
    expect(at(login.chips, 'agree')).toMatchObject({ text: '先处理华为要登录的', action: { type: 'open_deck' } });
    const review = await bar({ ...s, asks: [s.asks[0]] }, {});
    expect(review.scene).toBe('S18');
    expect(at(review.chips, 'agree')).toMatchObject({ text: '备好的 3 家都投出', action: { type: 'ask_primary' } });
    resetSuggestMemory();
    const plain = await bar({ ...s, asks: [] }, {});
    expect(plain.scene).toBe('S14');
    expect(texts(plain.chips)).toEqual(['把招商银行那份给我看看', '我先去忙，你接着投', '附件换成财务版那份']);
    expect(at(plain.chips, 'agree')?.action).toEqual({ type: 'open', surface: 'live', id: 'app-1' });
  });

  it('S16 缺信息：配合位是填一次整批放行', async () => {
    const s = state({ asks: [ask({ kind: 'info', title: '证件号码', count: 20 })] });
    const { chips } = await bar(s, {});
    expect(at(chips, 'agree')).toMatchObject({ text: '填证件号码，20 家一起放行', action: { type: 'open_deck', ask_id: 'ask-info' } });
  });

  it('S16 有模型时犹豫 / 纠正位放隐私担心和空着', async () => {
    const llm = llmByStance({ hesitate: [{ text: '我的证件号码安全吗' }], correct: [{ text: '证件号码我没有，空着' }] });
    const s = state({ asks: [ask({ kind: 'info', title: '证件号码', count: 20 })] });
    const { chips } = await bar(s, { last_assistant: '还差证件号码，20 家在等。' }, llm);
    expect(texts(chips)).toEqual(['填证件号码，20 家一起放行', '我的证件号码安全吗', '证件号码我没有，空着']);
  });

  it('S19 等你选：选项原文直接选进配合位；有模型时另一个选项也能放进纠正位', async () => {
    const s = state({ asks: [ask({ kind: 'choice', title: '是否接受调剂' })], askOptions: { 'ask-choice': ['接受调剂', '不接受'] } });
    const plain = await bar(s, {});
    expect(at(plain.chips, 'agree')).toMatchObject({ text: '选「接受调剂」', action: { type: 'ask_choose', ask_id: 'ask-choice', choice: '接受调剂' } });
    resetSuggestMemory();
    const llm = llmByStance({
      agree: [{ text: '选「接受调剂」', intent: 'ask_choose', target: '接受调剂' }],
      hesitate: [{ text: '调剂这题先给我看看', intent: 'open_deck', target: '选择' }],
      correct: [{ text: '选「不接受」', intent: 'ask_choose', target: '不接受' }],
    });
    const { chips } = await bar(s, { last_assistant: '是否接受调剂？' }, llm);
    expect(at(chips, 'hesitate')?.action).toEqual({ type: 'open_deck', ask_id: 'ask-choice' });
    expect(at(chips, 'correct')?.action).toEqual({ type: 'ask_choose', ask_id: 'ask-choice', choice: '不接受' });
  });

  it('S20 笔试：搜题直接起头放配合位（每轮 1 个起头）', async () => {
    const s = state({ dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-06' }], nextJobs: jobs('平安') });
    const { chips } = await bar(s, {});
    expect(at(chips, 'agree')?.text).toBe('考试时截图给你搜题');
    expect(starts(chips)).toHaveLength(1);
    expect(at(chips, 'agree')?.action).toEqual({ type: 'start_feature', feature_id: 'exam_search' });
  });

  it('S21 面试准备：配合位准备这场（带公司），犹豫 / 纠正位用本幕示例', async () => {
    const s = state({ dueSoon: [{ kind: 'interview', company: '字节跳动', at: '2026-11-06' }] });
    const { chips } = await bar(s, {});
    expect(texts(chips)).toEqual(['帮我准备字节跳动这场面试', '实习那段会被追问吗', '面试改到周五了']);
    expect(at(chips, 'agree')?.action).toEqual({ type: 'start_feature', feature_id: 'interview_prep', args: { company: '字节跳动' } });
  });

  it('S22 面后复盘：先说最卡的那题、补面试官反应', async () => {
    const { chips } = await bar(state(), { last_user: '今天面完了，感觉一般' });
    expect(texts(chips)).toEqual(['先说最卡的那题', '等等，我再想想', '面试官当时反应：']);
  });

  it('S24 低谷：看数在配合位，犹豫 / 纠正替他说出泄气和真原因', async () => {
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_user: '是不是我不行啊' });
    expect(texts(chips)).toEqual(['看我这个月的数', '先不投了，歇两天', '换个方向试试']);
  });

  it('S24 有模型时"接着投"是直接办的 do', async () => {
    const llm = llmByStance({ agree: [{ text: '接着投平安，别管了', intent: 'propose_batch', target: 'next' }], hesitate: [{ text: '先不投了，歇两天' }] });
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_user: '是不是我不行啊又被拒' }, llm);
    expect(at(chips, 'agree')).toMatchObject({ text: '接着投平安，别管了', action: { type: 'propose_batch' } });
  });

  it('低谷叠加：别的幕里犹豫位换成"看我这个月的数"，卡在等时不动', async () => {
    const s = state({ rejections7d: 6, asks: [ask({ kind: 'failed', count: 3 })] });
    const { chips } = await bar(s, {});
    expect(at(chips, 'agree')?.text).toBe('再试一次这 3 家');
    expect(at(chips, 'hesitate')?.text).toBe('看我这个月的数');
    const pick = state({ rejections7d: 6, openCard: card({ kind: 'batch_pick', pickedIds: ['j1'], allIds: ['j1'] }) });
    expect(texts((await bar(pick, {})).chips)).not.toContain('看我这个月的数');
  });

  it('S27 隔几天回来：从最急的开始（配合）、稍后（犹豫）', async () => {
    const s = state({ asks: [ask({ kind: 'review', count: 3 }), ask({ id: 'oq', kind: 'info', title: '开放题 2 道' })] });
    const { chips, scene } = await bar(s, { away_hours: 30 });
    expect(scene).toBe('S27');
    expect(texts(chips)).toEqual(['从最急的开始', '我先忙，等下处理', '不是这样，其实是：']);
    expect(at(chips, 'agree')?.action?.type).toBe('open_deck');
    expect(at(chips, 'hesitate')?.mode).toBe('exit');
  });

  it('S29 兜底：模型按立场接一句；没模型时配合位是能直接办的下一批', async () => {
    const llm = llmByStance({
      agree: [{ text: '平安那份我先看看' }],
      hesitate: [{ text: '先看平安靠谱吗', intent: 'start_feature', target: 'company_research:平安' }],
      correct: [{ text: '不对，我说的是美的' }],
    });
    const s = state({ nextJobs: jobs('平安', '美的') });
    const { chips, scene } = await bar(s, { last_assistant: '要不要先看看平安？' }, llm);
    expect(scene).toBe('S29');
    expect(texts(chips)).toEqual(['平安那份我先看看', '先看平安靠谱吗', '不对，我说的是美的']);
    resetSuggestMemory();
    const noModel = await bar(s, { last_assistant: '要不要先看看平安？' }, null);
    expect(at(noModel.chips, 'agree')).toMatchObject({ kind: 'do', action: { type: 'propose_batch' } });
  });

  it('S29 过线后不满三条时补满（真机 r2：S29 只剩两格），不复述他刚说的', async () => {
    const llm = llmByStance({ agree: [{ text: '后端名额缩了？那我还投吗' }], hesitate: [{ text: '大厂现在还招后端吗' }] });
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 1 }, mailConnected: false });
    const { chips, scene } = await bar(s, { last_user: '大厂现在还招后端吗', last_assistant: '后端名额缩了一些，但还在招。' }, llm);
    expect(scene).toBe('S29');
    expect(texts(chips)).not.toContain('大厂现在还招后端吗');
  });

  it('S29 新格补不满时，放回最近出过的固定入口 / 立场兜底，仍是三条（真机 r6：停在三格）', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 1 }, mailConnected: false });
    const req = { last_user: '大厂现在还卷吗', last_assistant: '还在招，只是更看重项目。' };
    await bar(s, req, null);
    const again = await bar(s, req, null);
    expect(again.scene).toBe('S29');
  });

  it('模型出错不抛；开发词 / 含糊 / 超长的格被丢', async () => {
    const boom: LLM = { complete: vi.fn(async () => { throw new Error('boom'); }) };
    const err = await bar(state({ nextJobs: jobs('平安') }), { last_assistant: '好的' }, boom);
    expect(err.degraded).toBe(true);
    expect(at(err.chips, 'agree')?.kind).toBe('do');
    const bad = llmByStance({
      agree: [{ text: '用这个工具登录' }],
      hesitate: [{ text: '我也不太清楚' }],
      correct: [{ text: '这是一句明显超过二十二个字上限的很长很长很长的回复' }],
    });
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

/** 回声模型：从 user 提示词里读"这一轮"，按立场把他说的、小芽说的拼进三条（真模型会这样随上下文变）。 */
function echoLlm(): LLM {
  return {
    complete: vi.fn(async (req: { messages: Array<{ content: string }> }) => {
      const prompt = req.messages[0]?.content ?? '';
      const u = /他说「([^」]*)」/.exec(prompt)?.[1] ?? '';
      const a = /小芽说「([^」]*)」/.exec(prompt)?.[1] ?? '';
      return reply({
        配合: [[`${u.slice(0, 8)}，就这样`], ['先投下一批', 'propose_batch', 'next']],
        犹豫: [[`${u.slice(0, 6)}，大概 ＿＿ 个：`, 'fill']],
        纠正: [[`${a.slice(0, 8)}，然后呢`]],
      });
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
    const t = texts(chips);
    expect(t.some(x => x.includes('有简历') || x === '还没有，先聊聊')).toBe(false);
    expect(at(chips, 'agree')?.text).toBe('我做过的一件事是：');
  });

  it('门还在时模型 / 示例写了门上的话也被 L5 挡下', async () => {
    const llm = llmByStance({ agree: [{ text: '有简历，我拖进来' }], hesitate: [{ text: '还没有，先聊聊' }], correct: [{ text: '我是 ＿＿ 届，找校招', intent: 'fill' }] });
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, mailConnected: false });
    const { chips } = await bar(s, { turns: [{ role: 'assistant', text: '你手上有简历吗？' }] }, llm);
    expect(texts(chips).some(x => x.includes('有简历') || x === '还没有，先聊聊')).toBe(false);
  });

  it('过线后不满三条时补到三条（本幕示例的说 / 填空，再通用兜底）', async () => {
    const s = state({
      batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 4, queued: 8 },
      held: { count: 3, companies: ['美的'], askId: 'ask-review' }, phoneLinked: false,
    });
    const { chips, scene } = await bar(s, {});
    expect(scene).toBe('S14');
    expect(at(chips, 'correct')?.text).toBe('附件换成财务版那份');
  });
});

describe('r4 · 模型优先：同幕不同上下文出不同格', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  for (const c of SAME_SCENE_CASES) {
    it(`${c.scene}：两轮说的不一样，三条就不一样，且点到这一轮的话`, async () => {
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

  it('卡幕：模型没写出卡的主动作时配合位仍是"就这 N 家"', async () => {
    const c = SAME_SCENE_CASES[3];
    const { chips } = await bar(c.s, c.a, echoLlm());
    expect(at(chips, 'agree')?.action?.type).toBe('start_card');
  });

  it('模型拿到这一幕的思路与这一轮', async () => {
    const llm = echoLlm();
    await suggestFor(SAME_SCENE_CASES[3].s, SAME_SCENE_CASES[3].a, llm);
    const arg = vi.mocked(llm.complete).mock.calls[0]?.[0];
    expect(arg?.system).toContain(guideFor('S13')?.text ?? '?');
    expect(arg?.messages[0]?.content).toContain('外包的我都不要');
  });

  it('意图换成真 id；换不出的丢（旧 {c} 格式仍认）', async () => {
    const llm = llmReturning([
      { text: '先投平安、美的', intent: 'propose_batch', target: '平安、美的' },
      { text: '查查腾讯靠谱吗', intent: 'start_feature', target: 'nope_feature' },
    ]);
    const { chips } = await bar(state({ nextJobs: jobs('平安', '美的') }), turn('平安和美的先投吧', '好的。'), llm);
    expect(chips.find(c => c.text === '先投平安、美的')?.action).toEqual({ type: 'propose_batch', job_ids: ['job-0', 'job-1'] });
    expect(texts(chips)).not.toContain('查查腾讯靠谱吗');
  });

  it('模型按立场写的格进对应立场位；同一立场第一条被丢时用第二条', async () => {
    const llm = llmByStance({
      agree: [{ text: '平安那份我先看看' }],
      hesitate: [{ text: '用这个工具登录' }, { text: '平安面试什么时候' }],
      correct: [{ text: '不对，我说的是美的' }],
    });
    const { chips, degraded } = await bar(state({ nextJobs: jobs('平安', '美的') }), turn('平安怎么样', '平安还在等。'), llm);
    expect(chips.map(c => [c.stance, c.text])).toEqual([['agree', '平安那份我先看看'], ['hesitate', '平安面试什么时候'], ['correct', '不对，我说的是美的']]);
    expect(degraded).toBe(false);
  });

  it('L12：下一轮不和上一轮出过的重样', async () => {
    const llm = llmByStance({ agree: [{ text: '平安那份我先看看' }], hesitate: [{ text: '平安面试什么时候' }] });
    const s = state({ nextJobs: jobs('平安') });
    const first = await bar(s, turn('平安怎么样', '平安还在等。'), llm);
    const second = await suggestFor(s, turn('平安怎么样', '平安还在等。'), llm);
    expect(texts(first.chips)).toContain('平安那份我先看看');
    expect(texts(second.chips)).not.toContain('平安那份我先看看');
    expect(second.chips).toHaveLength(3);
  });

  it('P1-2 loose 幕（S5 替他说处境）跳过 L11：本轮没提"家教"的模型格也留；strict 幕（S3）同一句被丢', async () => {
    const llm = () => llmByStance({ hesitate: [{ text: '做过家教，算吗' }] });
    const loose = await bar(interviewing(), { this_turn: { user: '没做过啥项目', assistant: '那有没有帮社团做过事？', tools: [], cards: [] } }, llm());
    expect(loose.scene).toBe('S5');
    expect(texts(loose.chips)).toContain('做过家教，算吗');
    resetSuggestMemory();
    const strict = await bar(interviewing(), { this_turn: { user: '', assistant: '这个课程项目做的是什么？', tools: [], cards: [] } }, llm());
    expect(strict.scene).toBe('S3');
    expect(texts(strict.chips)).not.toContain('做过家教，算吗');
  });

  it('stale 结果（钩子超时 / 被新一轮顶掉）不记上一轮，下一轮不会因 L12 少格', async () => {
    const llm = llmByStance({ agree: [{ text: '平安那份我先看看' }], hesitate: [{ text: '平安面试什么时候' }] });
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

  it('兜底：模型超时 3s → 旧配方补满三条，配合位能办，degraded', async () => {
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = suggestFor(state({ nextJobs: jobs('平安') }), turn('平安怎么样', '平安还在等。'), llm);
    await vi.advanceTimersByTimeAsync(3_000 + 10);
    const res = await pending;
    vi.useRealTimers();
    expect(SUGGEST_LLM_TIMEOUT_MS).toBe(3_000);
    wellFormed(res.chips);
    expect(res.chips).toHaveLength(3);
    expect(at(res.chips, 'agree')?.kind).toBe('do');
    expect(res.degraded).toBe(true);
  });

  it('兜底：模型 6 条全换不出 → 旧配方，degraded；正常时 degraded=false', async () => {
    const nowhere = (i: number): Row => ({ text: `去第${i}个地方`, intent: 'open', target: 'nowhere' });
    const bad = llmByStance({ agree: [nowhere(0), nowhere(1)], hesitate: [nowhere(2), nowhere(3)], correct: [nowhere(4), nowhere(5)] });
    const s = state({ nextJobs: jobs('平安') });
    const res = await bar(s, turn('平安怎么样', '平安还在等。'), bad);
    expect(res.degraded).toBe(true);
    expect(at(res.chips, 'agree')?.kind).toBe('do');
    resetSuggestMemory();
    expect((await bar(s, turn('平安怎么样', '平安还在等。'), echoLlm())).degraded).toBe(false);
  });

  it('只有一条是模型写的也算 degraded（< 2 条）', async () => {
    const llm = llmByStance({ agree: [{ text: '平安那份我先看看' }] });
    const res = await bar(state({ nextJobs: jobs('平安') }), turn('平安怎么样', '平安还在等。'), llm);
    expect(at(res.chips, 'agree')?.text).toBe('平安那份我先看看');
    expect(res.degraded).toBe(true);
  });

  it('能直接办的模型格不要求文字点名对象（L4 对 do 免检）：「接着投，别管了|propose_batch」留在条上', async () => {
    const llm = llmByStance({ agree: [{ text: '接着投，别管了', intent: 'propose_batch', target: 'next' }] });
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_user: '是不是我不行啊' }, llm);
    expect(at(chips, 'agree')?.text).toBe('接着投，别管了');
    expect(at(chips, 'agree')?.action?.type).toBe('propose_batch');
  });
  it('没模型时配方格按文字判立场：退出口 / 犹豫词进犹豫位，纠正词进纠正位，不全挤在配合位', async () => {
    const { chips } = await bar(state({ nextJobs: jobs('平安') }), { last_user: '是不是我不行啊' });
    expect(chips.map(c => c.stance)).toEqual(['agree', 'hesitate', 'correct']);
    expect(chips.some(c => c.seed_id?.startsWith('stance_'))).toBe(false);
  });
});

describe('邮件那几件：任何建议格都不经预览发不出邮件', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });
  const mailAsk = (over: Partial<SuggestAsk> = {}) => ask({ id: 'ask-mail', kind: 'review', title: '3 封邮件写好了', count: 3, mail: { purpose: 'apply', count: 3, bounced: false }, ...over });
  const noDirectSend = (chips: SuggestChip[]) => expect(chips.some(c => c.action?.type === 'ask_primary' && c.action.ask_id === 'ask-mail')).toBe(false);

  it('规则格：写好的 / 回信 / 跟进 / 退信 / 没发出去，都只打开卡组定位到这件', () => {
    expect(askNext(mailAsk())).toMatchObject({ text: '看写好的 3 封邮件', action: { type: 'open_deck', ask_id: 'ask-mail' } });
    expect(askNext(mailAsk({ count: 1, companies: ['甲科技'], mail: { purpose: 'apply', count: 1, bounced: false } }))?.action).toEqual({ type: 'open_deck', ask_id: 'ask-mail' });
    expect(askNext(mailAsk({ count: 1, companies: ['甲科技'], mail: { purpose: 'reply', count: 1, bounced: false } }))).toMatchObject({ text: '看给甲科技的回信', action: { type: 'open_deck' } });
    expect(askNext(mailAsk({ count: 1, companies: ['乙数据'], mail: { purpose: 'apply', count: 1, bounced: true } }))).toMatchObject({ text: '改乙数据的收件人', action: { type: 'open_deck' } });
    expect(askNext(mailAsk({ mail: { purpose: 'followup', count: 3, bounced: false } }))).toMatchObject({ text: '看给 3 家写的跟进', action: { type: 'open_deck' } });
    expect(askNext(mailAsk({ count: 1, companies: ['丙智能'], mail: { purpose: 'followup', count: 1, bounced: false } }))).toMatchObject({ text: '看给丙智能写的跟进', action: { type: 'open_deck' } });
    const failedSend = ask({ id: 'ask-f', kind: 'failed', title: '2 封没发出去', count: 2, mail_failed: { stage: 'send', reauth: true } });
    expect(askNext(failedSend)).toMatchObject({ text: '看没发出去的 2 封', action: { type: 'open_deck', ask_id: 'ask-f' } });
    // 没写成的「再写一次」不发信，可以直接做
    const failedDraft = ask({ id: 'ask-d', kind: 'failed', title: '1 封没写成', count: 1, mail_failed: { stage: 'draft', reauth: false } });
    expect(askNext(failedDraft)).toMatchObject({ text: '再写一次这 1 封', action: { type: 'ask_primary', ask_id: 'ask-d' } });
  });

  it('整条（没模型）：过目幕里配合位是看写好的邮件，不是「都投出」', async () => {
    const s = state({ batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 4, queued: 8 }, asks: [mailAsk()] });
    const { chips } = await bar(s, {}, null);
    expect(chips.find(c => c.action?.type === 'open_deck')).toMatchObject({ text: '看写好的 3 封邮件', action: { ask_id: 'ask-mail' } });
    noDirectSend(chips);
  });

  it('模型写「直接办」落到邮件那件上：换成打开卡组', async () => {
    const llm = llmByStance({ agree: [{ text: '写好的都发出去', intent: 'ask_primary', target: '过目' }] });
    const s = state({ asks: [mailAsk()] });
    const { chips } = await suggestFor(s, turn('好', '3 封邮件写好了，在等你里。'), llm);
    expect(chips.find(c => c.text === '写好的都发出去')?.action).toEqual({ type: 'open_deck', ask_id: 'ask-mail' });
    noDirectSend(chips);
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
