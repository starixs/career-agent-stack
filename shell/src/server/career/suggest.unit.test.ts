/**
 * 下一步条（plan-r2 §B.7）：十二个情境各出几格，next 具体能做，退出口只在有后台事时出，字数与公司名截断。
 * 状态用纯对象夹具（状态从哪来见 suggest-state.unit.test.ts）。
 */
import type { LLM } from '@career/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSuggest, SUGGEST_MAX_CHARS, type SuggestChip } from '../../shared/careerSuggest';
import { prePick } from './batch-propose';
import { buildSuggestions, cleanChip, resetSuggestMemory, SUGGEST_LLM_TIMEOUT_MS } from './suggest';
import { EXIT_CARD, EXIT_WHILE_RUNNING, resetExitRotation } from './suggest-seeds';
import { namesPhrase, shortCompany } from './suggest-text';
import type { SuggestAsk, SuggestState } from './suggest-types';

const state = (over: Partial<SuggestState> = {}): SuggestState => ({
  stage: 'batch', asks: [], openCard: null, batch: null, held: { count: 0, companies: [], askId: null },
  nextJobs: [], pool: { fits: 0, total: 0, outsourced: 0 },
  prefs: { keywords: ['财务'], cities: [], cohort: '2027' },
  resume: { has: true, name: '财务版', tailored: 0, experiences: 3 },
  mailConnected: true, phoneLinked: true, lastTailor: null, todaySent: 0, awayHours: 0, hour: 15, cohortGuess: 2027,
  ...over,
});
const ask = (over: Partial<SuggestAsk> & Pick<SuggestAsk, 'kind'>): SuggestAsk => ({ id: `ask-${over.kind}`, title: '', companies: [], count: 1, ...over });
const jobs = (...companies: string[]) => companies.map((company, i) => ({ job_id: `job-${i}`, company, known: true }));
const llmReturning = (text: string): LLM => ({ complete: vi.fn(async () => ({ text, usage: { input_tokens: 1, output_tokens: 1 } })) });
const slots = (chips: SuggestChip[]) => chips.map(c => c.slot);
const by = (chips: SuggestChip[], slot: string) => chips.find(c => c.slot === slot);

describe('下一步条', () => {
  beforeEach(() => { resetSuggestMemory(); resetExitRotation(); });

  it('第一次打开（没简历）：接话两条，没有退出口，届别是填空', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, prefs: { keywords: [], cities: [], cohort: null }, mailConnected: false });
    const chips = await buildSuggestions(s, { last_assistant: '手上有简历吗？' }, llmReturning('{"act":[{"text":"有简历，我拖进来"},{"text":"还没有，先聊聊"}],"shape":0}'));
    expect(chips.map(c => c.text)).toEqual(['有简历，我拖进来', '还没有，先聊聊', '提交前我能先看吗', '我是 2027 届，找校招']);
    expect(chips.some(c => c.slot === 'exit')).toBe(false);
    expect(chips[3].kind).toBe('fill');
  });

  it('访谈中：没有下一步那格，塑形给"先跳过 / 先聊到这"', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 1 }, prefs: { keywords: [], cities: [], cohort: '2027' } });
    const chips = await buildSuggestions(s, { last_assistant: '大作业做的是什么？' }, llmReturning('{"act":[{"text":"没做过什么大作业"},{"text":"有一段实习可以说"}],"shape":0}'));
    expect(slots(chips)).toEqual(['act', 'act', 'shape', 'shape']);
    expect(chips.slice(2).map(c => c.text)).toEqual(['这段先跳过', '今天先聊到这，明天接着']);
  });

  it('简历刚解析：下一步是推荐方向，塑形收手投过的', async () => {
    const s = state({ stage: 'direction', prefs: { keywords: [], cities: [], cohort: '2027' }, mailConnected: false });
    const chips = await buildSuggestions(s, { last_assistant: '入学时间写的 2023.09 还是 2023.08？' }, llmReturning('{"act":[{"text":"用 2023.09"},{"text":"用 2023.08"}],"shape":-1}'));
    expect(chips.map(c => c.text)).toEqual(['用 2023.09', '用 2023.08', '按我的经历推荐方向', '我之前手投过一些了']);
  });

  it('方向提议：小芽刚提了方向就不再出推荐方向，塑形填已说的城市', async () => {
    const s = state({ stage: 'direction', prefs: { keywords: [], cities: ['北京', '上海'], cohort: '2027' } });
    const chips = await buildSuggestions(s, { last_assistant: '先投财务分析、运营助理这两类方向，行吗？' }, llmReturning('{"act":[{"text":"行，就这两类"},{"text":"只投财务"}],"shape":0}'));
    expect(chips.map(c => c.text)).toEqual(['行，就这两类', '只投财务', '只看北京、上海', '不考虑外包']);
  });

  it('有勾选表在等：② 是表的主动作、① 是全投 / 换一批，④ 是先不投', async () => {
    const llm = llmReturning('{"act":[{"text":"不该被叫到"}],"shape":0}');
    const s = state({ openCard: { id: 'batch-pick:1', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1', 'j2', 'j3', 'j4', 'j5'], allIds: Array.from({ length: 18 }, (_, i) => `j${i + 1}`), more: 0 } });
    const chips = await buildSuggestions(s, { last_assistant: '先投这 5 家？' }, llm);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(chips.map(c => c.text)).toEqual(['全投，18 家都投', '换一批', '就这 5 家', EXIT_CARD]);
    expect(by(chips, 'next')?.action).toEqual({ type: 'start_card', card_id: 'batch-pick:1', job_ids: ['j1', 'j2', 'j3', 'j4', 'j5'] });
    expect(chips[0].action).toMatchObject({ type: 'start_card', job_ids: expect.arrayContaining(['j18']) });
    expect(chips[1].action).toEqual({ type: 'propose_batch' });
    expect(chips[3]).toMatchObject({ kind: 'do', action: { type: 'dismiss_card', card_id: 'batch-pick:1' } });
  });

  it('批量在跑：有退出口，next 是备好的都投出，塑形看在填的那家', async () => {
    const s = state({
      batch: { status: 'running', running: ['招商银行', '平安'], runningAppId: 'app-1', done: 4, queued: 8 },
      held: { count: 3, companies: ['美的'], askId: 'ask-review' },
      asks: [ask({ id: 'ask-review', kind: 'review', title: '3 家填好了', count: 3 })],
    });
    const chips = await buildSuggestions(s, {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '备好的 3 家都投出', action: { type: 'ask_primary', ask_id: 'ask-review' } });
    expect(by(chips, 'shape')).toMatchObject({ text: '把招商银行那份给我看看', action: { type: 'open', surface: 'live', id: 'app-1' } });
    expect(by(chips, 'exit')?.text).toBe(EXIT_WHILE_RUNNING);
  });

  it('有要登录的：next 点名公司开卡组', async () => {
    const s = state({ asks: [ask({ id: 'ask-login', kind: 'login', title: '2 个网站要你登录', companies: ['华为技术有限公司', '字节跳动'], count: 2 })], nextJobs: jobs('平安') });
    const chips = await buildSuggestions(s, {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '先处理华为技术、字节跳动要登录的', action: { type: 'open_deck', ask_id: 'ask-login' } });
    expect(by(chips, 'shape')).toMatchObject({ text: '再投一批', action: { type: 'propose_batch' } });
    expect(by(chips, 'exit')).toBeDefined();
  });

  it('缺信息：填一次整批放行，塑形给底气', async () => {
    const s = state({ asks: [ask({ id: 'ask-info', kind: 'info', title: '证件号码', count: 20 })] });
    const chips = await buildSuggestions(s, { last_assistant: '有 20 家要证件号码' }, llmReturning('{"act":[{"text":"这批先不填证件号"}],"shape":0}'));
    expect(chips.map(c => c.text)).toEqual(['这批先不填证件号', '填证件号码，20 家一起放行', '我的身份证号安全吗', '我先去忙']);
    expect(by(chips, 'next')?.action).toEqual({ type: 'open_deck', ask_id: 'ask-info' });
  });

  it('有 3 家没填成：next 再试一次，塑形是这 3 家不投了', async () => {
    const s = state({ asks: [ask({ id: 'ask-failed', kind: 'failed', title: '3 家没填成', count: 3 })] });
    const chips = await buildSuggestions(s, {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '再试一次这 3 家', action: { type: 'ask_primary', ask_id: 'ask-failed' } });
    expect(by(chips, 'shape')?.text).toBe('这 3 家不投了');
  });

  it('隔两天回来：几件一起时从最急的开始，塑形能直接看开放题', async () => {
    const s = state({ awayHours: 50, todaySent: 0, asks: [
      ask({ id: 'ask-login', kind: 'login', title: '美团 · 要登录', companies: ['美团'] }),
      ask({ id: 'ask-q', kind: 'review', title: '京东 · 开放题过目', companies: ['京东'] }),
    ] });
    const chips = await buildSuggestions(s, {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '从最急的开始', action: { type: 'open_deck' } });
    expect(by(chips, 'shape')).toMatchObject({ text: '先看开放题写了什么', action: { type: 'open_deck', ask_id: 'ask-q' } });
    expect(by(chips, 'exit')).toBeDefined();
  });

  it('跑题问题答完：next 回到下一批，点名公司', async () => {
    const s = state({ nextJobs: jobs('招商银行', '平安') });
    const chips = await buildSuggestions(s, { last_assistant: '字节泡了 20 天一般是在横向比较' }, llmReturning('{"act":[{"text":"那字节还等吗"}],"shape":-1}'));
    expect(chips[0].text).toBe('那字节还等吗');
    expect(by(chips, 'next')).toMatchObject({ text: '先投招商银行、平安这 2 家', action: { type: 'propose_batch', job_ids: ['job-0', 'job-1'] } });
    expect(chips.some(c => c.slot === 'exit')).toBe(false);
  });

  it('没有匹配岗位：自己贴链接、有新岗位叫我、放宽城市', async () => {
    const s = state({ prefs: { keywords: ['财务'], cities: ['杭州'], cohort: '2027' } });
    const chips = await buildSuggestions(s, {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '我自己贴几个岗位链接', kind: 'say' });
    expect(chips.filter(c => c.slot === 'shape').map(c => c.text)).toEqual(['有新岗位进来叫我', '城市不限了', '方向改成：']);
  });

  it('定制卡刚出：就这样投美团 / 打开整份 / 其余也这样改', async () => {
    const s = state({ openCard: { id: 'tailor:t1', kind: 'tailor_diff', picked: [], pickedIds: [], allIds: [], more: 0 }, lastTailor: { card_id: 'tailor:t1', company: '美团', job_id: 'job-mt', tailored_id: 't1', changes: 6 } });
    const chips = await buildSuggestions(s, {}, null);
    expect(chips.map(c => c.text)).toEqual(['可以，就这样投美团', '改得太多了，轻一点', '打开整份看看', '其余的也都这样改']);
    expect(chips[0].action).toEqual({ type: 'propose_batch', job_ids: ['job-mt'] });
    expect(chips[2].action).toEqual({ type: 'open', surface: 'resume', id: 't1' });
  });

  it('没简历第一次打开：没有退出口', async () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 } });
    const chips = await buildSuggestions(s, {}, null);
    expect(chips.some(c => c.slot === 'exit')).toBe(false);
    expect(by(chips, 'next')?.text).toBe('还没有，先聊聊');
  });

  it('第一份：先投一家给我看，带岗位 id', async () => {
    const chips = await buildSuggestions(state({ stage: 'first', nextJobs: jobs('宁德时代新能源科技股份有限公司', '平安') }), {}, null);
    expect(by(chips, 'next')).toMatchObject({ text: '先投宁德时代新…一家给我看', action: { type: 'propose_batch', job_ids: ['job-0'] } });
  });

  it('公司名超过 6 字截断、最多点两家', () => {
    expect(shortCompany('华为技术有限公司')).toBe('华为技术');
    expect(shortCompany('中国建设银行股份有限公司')).toBe('中国建设银行');
    expect(shortCompany('宁德时代新能源科技股份有限公司')).toBe('宁德时代新…');
    expect(namesPhrase(['招商银行', '平安', '美的', '格力'], 5)).toBe('招商银行、平安等 5 家');
    expect(namesPhrase(['招商银行', '平安'])).toBe('招商银行、平安');
  });

  it('批量时下一批多于两家：点两家 + 等 n 家', async () => {
    const chips = await buildSuggestions(state({ nextJobs: jobs('招商银行', '平安', '美的', '格力', '海尔') }), {}, null);
    expect(by(chips, 'next')?.text).toBe('先投招商银行、平安等 5 家');
  });

  it('cohort 缺时 shape 出届别', async () => {
    const s = state({ stage: 'direction', prefs: { keywords: [], cities: [], cohort: null }, cohortGuess: 2028 });
    const chips = await buildSuggestions(s, {}, null);
    expect(chips.find(c => c.seed_id === 'pref_cohort')).toMatchObject({ text: '我是 2028 届，找校招', kind: 'fill' });
  });

  it('深夜有后台事：退出口说今天先到这', async () => {
    const chips = await buildSuggestions(state({ hour: 23, asks: [ask({ kind: 'failed', count: 2 })] }), {}, null);
    expect(by(chips, 'exit')?.text).toBe('今天先到这，明天接着');
  });

  it('模型超时：只出规则条，且规则层 < 50ms', async () => {
    const s = state({ asks: [ask({ kind: 'failed', count: 3 })], nextJobs: jobs('平安') });
    const t0 = performance.now();
    const rulesOnly = await buildSuggestions(s, { last_assistant: '好的' }, null);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(rulesOnly).toHaveLength(4);
    resetSuggestMemory(); resetExitRotation();
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = buildSuggestions(s, { last_assistant: '好的' }, llm);
    await vi.advanceTimersByTimeAsync(SUGGEST_LLM_TIMEOUT_MS + 10);
    const chips = await pending;
    vi.useRealTimers();
    expect(chips).toEqual(rulesOnly);
    expect(chips.some(c => c.slot === 'act')).toBe(false);
  });

  it('模型出错时不抛错，只出规则条', async () => {
    const llm: LLM = { complete: vi.fn(async () => { throw new Error('boom'); }) };
    const chips = await buildSuggestions(state({ nextJobs: jobs('平安') }), { last_assistant: '好的' }, llm);
    expect(chips.some(c => c.slot === 'act')).toBe(false);
    expect(by(chips, 'next')).toBeDefined();
  });

  it('全部 22 字内，接话不含开发者词，过前端校验原样保留', async () => {
    const s = state({ asks: [ask({ kind: 'login', companies: ['中国石油天然气集团有限公司', '中国移动通信集团有限公司'], count: 9 })], nextJobs: jobs('平安') });
    const chips = await buildSuggestions(s, { last_assistant: '要登录' }, llmReturning('{"act":[{"text":"用这个工具登录"},{"text":"这是一句明显超过二十二个字上限的很长很长很长的回复"}],"shape":0}'));
    expect(chips.every(c => c.text.length <= SUGGEST_MAX_CHARS)).toBe(true);
    expect(chips.some(c => c.slot === 'act')).toBe(false);
    expect(parseSuggest({ chips })).toEqual(chips);
  });

  it('同一条老种子不会连着出', async () => {
    const s = state({ stage: 'released', nextJobs: jobs('平安') });
    const first = await buildSuggestions(s, {}, null);
    const second = await buildSuggestions(s, {}, null);
    const ids = (c: SuggestChip[]) => c.filter(x => x.slot === 'shape').map(x => x.seed_id);
    expect(ids(first).some(id => ids(second).includes(id))).toBe(false);
  });

  it('cleanChip 去掉引号、JSON 残渣', () => {
    expect(cleanChip('{"a":1}')).toBeNull();
    expect(cleanChip('「好的」')).toBe('好的');
  });
});

describe('建议条前端校验', () => {
  it('不认识的 action 丢掉、kind 退回 say；形状不对的 action 也一样', () => {
    const chips = parseSuggest({ chips: [
      { text: '去火星', slot: 'next', kind: 'do', action: { type: 'launch' }, seed_id: null },
      { text: '就这 5 家', slot: 'next', kind: 'do', action: { type: 'start_card', card_id: 'c', job_ids: [1] }, seed_id: null },
      { text: '换一批', slot: 'act', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
      { text: '城市：', slot: 'shape', kind: 'fill', seed_id: 'x' },
    ] });
    expect(chips.map(c => c.kind)).toEqual(['say', 'say', 'do', 'fill']);
    expect(chips[0].action).toBeUndefined();
    expect(chips[2].action).toEqual({ type: 'propose_batch' });
  });
});

describe('批量勾选表默认勾选', () => {
  it('一家公司只勾一个岗，勾满为止', () => {
    const rows = prePick([
      { company: '招商银行' }, { company: '招商银行' }, { company: '平安' }, { company: '美的' },
    ], 2);
    expect(rows.map(r => r.picked)).toEqual([true, false, true, false]);
  });
});
