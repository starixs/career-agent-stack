/**
 * 自动质量线 L1–L9、L11、L12、L14 正反例（L10 回应性、L13 类型多样在 suggest.unit.test.ts 端到端测）。
 */
import { describe, expect, it } from 'vitest';

import type { SuggestChip } from '../../shared/careerSuggest';
import { doChip, featureChip, sayChip } from './suggest-chip';
import { state } from './suggest-fixtures';
import { anchorsOf, echoesUser, entitiesOf, lintChip, lintChips, overlapRatio, type LintCtx } from './suggest-lint';

const model = (text: string): SuggestChip => ({ text, slot: 'act', kind: 'say', mode: 'answer', seed_id: null });
const rule = (text: string) => sayChip(text, 'answer', 't');
const ctx = (over: Partial<LintCtx> = {}): LintCtx => ({
  scene: 'S29', entities: entitiesOf(state({ nextJobs: [{ job_id: 'j', company: '招商银行', known: true }] }), ['这个课程项目做的是什么？']),
  cardKind: null, recent: new Set(), ...over,
});

describe('lint', () => {
  it('L8 同一条里整句很像的只留先来的，几种不同说法都留', () => {
    const c = ctx({ entities: ['简历', '接口', '数据库'] });
    const near = lintChips([model('先出一版简历看看'), model('直接出一版简历看看')], c);
    expect(near.kept.map(k => k.text)).toEqual(['先出一版简历看看']);
    expect(near.dropped[0]?.rule).toBe('L8');
    const options = lintChips([model('数据库和接口都是我自己写的'), model('接口是我写的，数据库也管了一部分')], c);
    expect(options.kept).toHaveLength(2);
  });

  it('L14 不复述他刚说的那句（真机 r2：「接口是我写的，数据库也管了一部分」原样回到条上）', () => {
    const said = '接口是我写的，数据库也管了一部分';
    expect(lintChip(model('接口是我写的，数据库也管了一部分'), ctx({ lastUser: said, entities: ['接口'] }))).toBe('L14');
    expect(lintChip(rule('还没有，先聊聊'), ctx({ lastUser: '还没有，先聊聊' }))).toBe('L14');
    expect(lintChip(model('接口用的 Node，库是 MySQL'), ctx({ lastUser: said, entities: ['接口'] }))).toBeNull();
    expect(echoesUser(rule('先投招商银行'), '')).toBe(false);
  });

  it('L1 长度', () => {
    expect(lintChip(rule('好'), ctx())).toBe('L1');
    expect(lintChip(rule('这是一句明显超过二十二个字上限的很长很长很长的回复'), ctx())).toBe('L1');
    expect(lintChip(rule('先投招商银行'), ctx())).toBeNull();
  });

  it('L2 开发词', () => {
    expect(lintChip(rule('用这个工具登录'), ctx())).toBe('L2');
    expect(lintChip(rule('存进经历库'), ctx())).toBe('L2');
    expect(lintChip(rule('帮我登录招商银行'), ctx())).toBeNull();
  });

  it('L3 残渣', () => {
    expect(lintChip(rule('{"a":1}'), ctx())).toBe('L3');
    expect(lintChip(rule('，先投'), ctx())).toBe('L3');
    expect(lintChip(rule('好的。。先投'), ctx())).toBe('L3');
    expect(lintChip(rule('大概 ＿＿ 人参加：'), ctx())).toBeNull();
  });

  it('L4 模型格要有对象，规则模板不查', () => {
    expect(lintChip(model('我也不太清楚'), ctx())).toBe('L4');
    expect(lintChip(model('是几个人一组的课程作业'), ctx())).toBeNull();
    expect(lintChip(model('先投招商银行'), ctx())).toBeNull();
    expect(lintChip(rule('我也不太清楚'), ctx())).toBeNull();
  });

  it('L5 不和底下卡的按钮撞', () => {
    expect(lintChip(rule('先不投，我去忙'), ctx({ cardKind: 'batch_pick' }))).toBe('L5');
    expect(lintChip(rule('打开整份'), ctx({ cardKind: 'tailor_diff' }))).toBe('L5');
    expect(lintChip(rule('这批先放着，我去忙'), ctx({ cardKind: 'batch_pick' }))).toBeNull();
  });

  it('L6 不替他打包票', () => {
    expect(lintChip(rule('放心，肯定能过'), ctx())).toBe('L6');
    expect(lintChip(rule('这家能过吗'), ctx())).toBeNull();
  });

  it('L7 不以"你发我"收尾', () => {
    expect(lintChip(rule('把 JD 粘贴给你'), ctx())).toBe('L7');
    expect(lintChip(rule('考完跟你说结果'), ctx())).toBeNull();
  });

  it('L8 同字、同动作、两个退出口、两个起头只留一个（S26 例外）', () => {
    const chips = [
      doChip('再投一批', 'advance', { type: 'propose_batch' }, 'a'), doChip('换一批', 'advance', { type: 'propose_batch' }, 'b'),
      sayChip('我先去忙', 'exit', 'c'), sayChip('今天先到这', 'exit', 'd'),
      featureChip('exam_search'), featureChip('company_research'), rule('我先去忙'),
    ];
    const { kept, dropped } = lintChips(chips, ctx());
    expect(kept.map(c => c.text)).toEqual(['再投一批', '我先去忙', '考试时截图给你搜题']);
    expect(dropped.every(d => d.rule === 'L8')).toBe(true);
    expect(lintChips([featureChip('exam_search'), featureChip('company_research')], ctx({ scene: 'S26' })).kept).toHaveLength(2);
  });

  it('L8 落点相同也算重复：开现场 = 起头网申进展，出勾选表 = 起头批量投递', () => {
    const live = lintChips([doChip('把招商那份给我看看', 'advance', { type: 'open', surface: 'live', id: 'a1' }, 'p'), featureChip('live')], ctx());
    expect(live.kept.map(c => c.text)).toEqual(['把招商那份给我看看']);
    const batch = lintChips([doChip('先投平安这 1 家', 'advance', { type: 'propose_batch', job_ids: ['j1'] }, 'n'), featureChip('batch')], ctx());
    expect(batch.kept.map(c => c.text)).toEqual(['先投平安这 1 家']);
  });

  it('L9 冷却中的起头不出（S26 例外）', () => {
    const recent = new Set(['feat_exam_search']);
    expect(lintChip(featureChip('exam_search'), ctx({ recent }))).toBe('L9');
    expect(lintChip(featureChip('exam_search'), ctx({ recent, scene: 'S26' }))).toBeNull();
  });

  it('L11 模型格要点到这一轮或状态；更早的历史词不算锚；规则模板与能办格不查；S26 例外', () => {
    const s = state({ nextJobs: [{ job_id: 'j', company: '招商银行', known: true }] });
    const anchors = anchorsOf(s, ['这次笔试考了什么']);
    const withHistory = ctx({ entities: entitiesOf(s, ['数据库课设做了三周', '这次笔试考了什么']), anchors });
    expect(lintChip(model('数据库课设我再补一点'), withHistory)).toBe('L11');
    expect(lintChip(model('笔试主要考行测'), withHistory)).toBeNull();
    expect(lintChip(model('先投招商银行'), withHistory)).toBeNull();
    expect(lintChip(rule('数据库课设我再补一点'), withHistory)).toBeNull();
    expect(lintChip({ ...model('数据库课设我再补一点'), kind: 'do', action: { type: 'propose_batch' } }, withHistory)).toBeNull();
    expect(lintChip(model('数据库课设我再补一点'), { ...withHistory, scene: 'S26' })).toBeNull();
  });

  it('L12 和上一轮同字或很像就丢；卡的主动作放行', () => {
    const lastShown = [rule('先投招商银行这 5 家'), rule('我先去忙')];
    expect(lintChip(rule('我先去忙'), ctx({ lastShown }))).toBe('L12');
    expect(lintChip(rule('先投招商银行这 5 家吧'), ctx({ lastShown }))).toBe('L12');
    expect(overlapRatio('先投招商银行这 5 家', '先投招商银行这 5 家吧')).toBeGreaterThanOrEqual(0.7);
    expect(lintChip(rule('看招商银行那份'), ctx({ lastShown }))).toBeNull();
    const main = doChip('先投招商银行这 5 家', 'advance', { type: 'start_card', card_id: 'c', job_ids: ['j'] }, 's13');
    expect(lintChip(main, ctx({ lastShown }))).toBeNull();
  });
});
