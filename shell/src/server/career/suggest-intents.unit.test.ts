/**
 * 意图解析（plan-r4-suggest §3.2 / §5.1）：每种 intent 正反例；越界意图退 say；target 换不出的丢并留日志。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUGGEST_INTENTS, type SuggestIntent } from './suggest-guide-types';
import { ask, card, jobs, state } from './suggest-fixtures';
import { ModelOut, modeOf, resolveChip, type ModelChip } from './suggest-intents';
import type { SuggestState } from './suggest-types';

const chip = (over: Partial<ModelChip> & Pick<ModelChip, 'intent'>): ModelChip => ({ text: '就这么办吧', target: null, ...over });
const resolve = (c: ModelChip, s: SuggestState, allowed: readonly SuggestIntent[] = SUGGEST_INTENTS) => resolveChip(c, { s, allowed });

const pickCard = card({ id: 'bp1', kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1', 'j2'], allIds: ['j1', 'j2', 'j3'] });

describe('意图 → 动作', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('文字里有空（＿＿ / __ / ____）一律是填空格，不管模型写的什么意图', () => {
    for (const [text, intent] of [['做过的事我挑两段说：＿＿', 'say'], ['我是 __ 届，找校招', 'start_feature'], ['大概投了 ____ 家', 'open']] as const) {
      const c = resolve(chip({ text, intent, target: 'live' }), state());
      expect(c?.kind).toBe('fill');
      expect(c?.action).toBeUndefined();
    }
  });

  it('start_feature：模型编的近似 id（explore / resume_build / resume_review）对到清单里；对不上的照旧丢', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = state();
    expect(resolve(chip({ intent: 'start_feature', target: 'explore' }), s)?.action).toEqual({ type: 'start_feature', feature_id: 'direction_explore' });
    expect(resolve(chip({ intent: 'start_feature', target: 'resume_build' }), s)?.action).toEqual({ type: 'start_feature', feature_id: 'resume_editor' });
    expect(resolve(chip({ intent: 'start_feature', target: 'resume_review' }), s)?.action).toEqual({ type: 'start_feature', feature_id: 'resume_editor' });
    expect(resolve(chip({ intent: 'start_feature', target: '方向探索' }), s)?.action).toEqual({ type: 'start_feature', feature_id: 'direction_explore' });
    expect(resolve(chip({ intent: 'start_feature', target: 'teleport' }), s)).toBeNull();
  });

  it('start_card picked / all；没有勾选表就丢', () => {
    const s = state({ openCard: pickCard });
    expect(resolve(chip({ intent: 'start_card', target: 'picked' }), s)?.action).toEqual({ type: 'start_card', card_id: 'bp1', job_ids: ['j1', 'j2'] });
    expect(resolve(chip({ intent: 'start_card', target: 'all' }), s)?.action).toEqual({ type: 'start_card', card_id: 'bp1', job_ids: ['j1', 'j2', 'j3'] });
    expect(resolve(chip({ intent: 'start_card', target: 'picked' }), state())).toBeNull();
  });

  it('propose_batch：next → 下一批 id；公司名 → 对应 job；认不出的公司丢', () => {
    const s = state({ nextJobs: jobs('平安银行', '美的集团') });
    expect(resolve(chip({ intent: 'propose_batch', target: 'next' }), s)?.action).toEqual({ type: 'propose_batch', job_ids: ['job-0', 'job-1'] });
    expect(resolve(chip({ intent: 'propose_batch', target: '美的' }), s)?.action).toEqual({ type: 'propose_batch', job_ids: ['job-1'] });
    expect(resolve(chip({ intent: 'propose_batch' }), s)?.action).toEqual({ type: 'propose_batch' });
    expect(resolve(chip({ intent: 'propose_batch', target: '腾讯' }), s)).toBeNull();
  });

  it('open_deck：按种类中文名 / 公司找事；找不到丢', () => {
    const s = state({ asks: [ask({ kind: 'info', title: '证件号码' }), ask({ kind: 'login', companies: ['华为'] })] });
    expect(resolve(chip({ intent: 'open_deck', target: '登录' }), s)?.action).toEqual({ type: 'open_deck', ask_id: 'ask-login' });
    expect(resolve(chip({ intent: 'open_deck', target: '华为' }), s)?.action).toEqual({ type: 'open_deck', ask_id: 'ask-login' });
    expect(resolve(chip({ intent: 'open_deck', target: '证件号码' }), s)?.action).toEqual({ type: 'open_deck', ask_id: 'ask-info' });
    expect(resolve(chip({ intent: 'open_deck', target: 'Offer' }), s)).toBeNull();
  });

  it('ask_primary：只接过目 / 没填成 / 开始；缺信息要开卡组，丢', () => {
    const s = state({ asks: [ask({ kind: 'info' }), ask({ kind: 'review', count: 3 })] });
    expect(resolve(chip({ intent: 'ask_primary', target: '过目' }), s)?.action).toEqual({ type: 'ask_primary', ask_id: 'ask-review' });
    expect(resolve(chip({ intent: 'ask_primary', target: '缺信息' }), state({ asks: [ask({ kind: 'info' })] }))).toBeNull();
  });

  it('ask_choose：选项原文或文字里含选项；不是 choice 的事不接', () => {
    const s = state({ asks: [ask({ kind: 'choice' })], askOptions: { 'ask-choice': ['接受调剂', '不接受'] } });
    expect(resolve(chip({ intent: 'ask_choose', target: '不接受' }), s)?.action).toEqual({ type: 'ask_choose', ask_id: 'ask-choice', choice: '不接受' });
    expect(resolve(chip({ intent: 'ask_choose', text: '选接受调剂' }), s)?.action).toEqual({ type: 'ask_choose', ask_id: 'ask-choice', choice: '接受调剂' });
    const confirm = state({ asks: [ask({ kind: 'confirm' })], askOptions: { 'ask-confirm': ['是'] } });
    expect(resolve(chip({ intent: 'ask_choose', target: '是' }), confirm)).toBeNull();
  });

  it('open：live 带在填的申请 id；resume:tailored 要有定制；未知页面丢', () => {
    const s = state({ batch: { status: 'running', running: ['招商银行'], runningAppId: 'app-1', done: 0, queued: 2 } });
    expect(resolve(chip({ intent: 'open', target: 'live' }), s)?.action).toEqual({ type: 'open', surface: 'live', id: 'app-1' });
    expect(resolve(chip({ intent: 'open', target: 'dossier:招商' }), s)?.action).toEqual({ type: 'open', surface: 'dossier', id: 'app-1' });
    expect(resolve(chip({ intent: 'open', target: 'resume:tailored' }), s)).toBeNull();
    const t = state({ lastTailor: { card_id: 'c', company: '平安', job_id: 'j', tailored_id: 't1', changes: 3 } });
    expect(resolve(chip({ intent: 'open', target: 'resume:tailored' }), t)?.action).toEqual({ type: 'open', surface: 'resume', id: 't1' });
    expect(resolve(chip({ intent: 'open', target: 'settings' }), s)).toBeNull();
  });

  it('start_feature：功能 id 加状态里认识的公司（全名）；不认识的功能丢；mode 强制 start', () => {
    const s = state({ nextJobs: jobs('平安银行') });
    const c = resolve(chip({ intent: 'start_feature', target: 'company_research:平安' }), s);
    expect(c?.action).toEqual({ type: 'start_feature', feature_id: 'company_research', args: { company: '平安银行' } });
    expect(c).toMatchObject({ mode: 'start', kind: 'do', seed_id: 'feat_company_research' });
    expect(resolve(chip({ intent: 'start_feature', target: 'company_research:腾讯' }), s)?.action).toEqual({ type: 'start_feature', feature_id: 'company_research' });
    expect(resolve(chip({ intent: 'start_feature', target: 'teleport' }), s)).toBeNull();
  });

  it('dismiss_card 要有卡', () => {
    expect(resolve(chip({ intent: 'dismiss_card' }), state({ openCard: pickCard }))?.action).toEqual({ type: 'dismiss_card', card_id: 'bp1' });
    expect(resolve(chip({ intent: 'dismiss_card' }), state())).toBeNull();
  });

  it('紧凑行：["文字"] / ["文字","intent"] / ["文字","intent","target"]；坏行丢，缺 c 整体失败', () => {
    const out = ModelOut.parse({ c: [['先这样'], ['先投下一批', 'propose_batch', 'next'], ['看现场', 'open', null], ['太多', 'say', 'x', 'y'], [], [1], 'bad', { text: '旧格式' }] });
    expect(out.chips).toEqual([
      { text: '先这样', intent: 'say', target: null },
      { text: '先投下一批', intent: 'propose_batch', target: 'next' },
      { text: '看现场', intent: 'open', target: null },
    ]);
    expect(ModelOut.safeParse({ chips: [{ text: '旧格式' }] }).success).toBe(false);
    expect(ModelOut.parse({ c: Array.from({ length: 12 }, (_, i) => [`第${i}条`]) }).chips).toHaveLength(6);
  });

  it('按立场分组：配合 / 犹豫 / 纠正各收最多两条，带上 stance，按立场顺序展开；一行或几行都认', () => {
    const out = ModelOut.parse({
      纠正: [['不是这样，其实是：', 'fill']],
      配合: [['就投这 5 家', 'start_card', 'picked'], ['好'], ['多的第三条']],
      犹豫: ['平安那家靠谱吗'],
    });
    expect(out.chips).toEqual([
      { text: '就投这 5 家', intent: 'start_card', target: 'picked', stance: 'agree' },
      { text: '好', intent: 'say', target: null, stance: 'agree' },
      { text: '平安那家靠谱吗', intent: 'say', target: null, stance: 'hesitate' },
      { text: '不是这样，其实是：', intent: 'fill', target: null, stance: 'correct' },
    ]);
    expect(ModelOut.safeParse({ 别的: [['x']] }).success).toBe(false);
  });

  it('mode 由服务端按意图推：say 用这一幕的回应 mode、带退出词的 say → exit、fill/ask_choose → option、能办 → advance、起头 → start、先放着 → exit', () => {
    expect(modeOf('say', '平安再看看', 'option')).toBe('option');
    expect(modeOf('say', '平安再看看')).toBe('answer');
    expect(modeOf('say', '我先去忙了')).toBe('exit');
    expect(modeOf('fill', '大概 ＿＿ 人：')).toBe('option');
    expect(modeOf('ask_choose', '选是')).toBe('option');
    expect(modeOf('propose_batch', '明天接着投下一批')).toBe('advance');
    expect(modeOf('start_feature', '查平安')).toBe('start');
    expect(modeOf('dismiss_card', '这批先放着')).toBe('exit');
  });

  it('未知 intent → say；越界意图 → say；fill 没留空 → say', () => {
    const out = ModelOut.parse({ c: [['先这样', 'teleport']] });
    expect(out.chips).toEqual([{ text: '先这样', intent: 'say', target: null }]);
    const s = state({ nextJobs: jobs('平安') });
    const outOfScene = resolve(chip({ intent: 'propose_batch', target: 'next' }), s, ['say']);
    expect(outOfScene?.kind).toBe('say');
    expect(outOfScene?.action).toBeUndefined();
    expect(resolve(chip({ intent: 'fill', text: '我是财务专业' }), s)?.kind).toBe('say');
    expect(resolve(chip({ intent: 'fill', text: '大概 ＿＿ 人参加：' }), s)?.kind).toBe('fill');
    expect(resolveChip(chip({ intent: 'say', text: '平安再看看' }), { s, allowed: SUGGEST_INTENTS, replyMode: 'option' })?.mode).toBe('option');
    expect(resolve(chip({ intent: 'say', text: '我先去忙了' }), s)?.mode).toBe('exit');
  });

  it('换不出的丢并记日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolve(chip({ intent: 'ask_primary', target: '登录' }), state())).toBeNull();
    expect(warn).toHaveBeenCalledWith('[career-suggest] unresolved ask_primary 登录');
  });
});
