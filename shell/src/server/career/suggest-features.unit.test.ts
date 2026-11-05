/**
 * 功能发现（plan-r3-suggest §4.5）：两表 id 一致、条件、冷却、S26 起头（一行三条按立场）。
 */
import type { LLM } from '@career/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_IDS } from '../../shared/careerFeatures';
import { buildSuggestions, resetSuggestMemory } from './suggest';
import { FEATURE_PRIORITY, FEATURE_WHEN_IDS, featureChips } from './suggest-features';
import { ask, input, jobs, state } from './suggest-fixtures';
import type { SceneId } from './suggest-scene';

const ids = (scene: SceneId, s = state(), recent = new Set<string>()) =>
  featureChips(s, { scene, input: input() }, recent, 20).map(c => (c.action?.type === 'start_feature' ? c.action.feature_id : null));

describe('功能起头', () => {
  beforeEach(() => resetSuggestMemory());

  it('条件表与优先表的 id 集合 === FEATURE_IDS', () => {
    expect(new Set(FEATURE_WHEN_IDS)).toEqual(new Set(FEATURE_IDS));
    expect(new Set(FEATURE_PRIORITY)).toEqual(new Set(FEATURE_IDS));
    expect(FEATURE_PRIORITY).toHaveLength(FEATURE_IDS.length);
  });

  it('没连邮箱才出邮箱；有登录且没连手机才出手机', () => {
    expect(ids('S29', state({ stage: 'first', mailConnected: false }))).toContain('mail_bind');
    expect(ids('S29', state({ stage: 'first', mailConnected: true }))).not.toContain('mail_bind');
    expect(ids('S29', state({ phoneLinked: false, asks: [ask({ kind: 'login' })] }))).toContain('phone_link');
    expect(ids('S29', state({ phoneLinked: false }))).not.toContain('phone_link');
    expect(ids('S29', state({ phoneLinked: true, asks: [ask({ kind: 'login' })] }))).not.toContain('phone_link');
  });

  it('截止驱动：三天内笔试才出搜题，点名公司', () => {
    const s = state({ dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-06' }] });
    const chips = featureChips(s, { scene: 'S29', input: input() }, new Set(), 20);
    expect(chips.find(c => c.seed_id === 'feat_exam_practice')).toMatchObject({ text: '先练几道字节跳动的题', action: { args: { company: '字节跳动' } } });
    expect(ids('S29', state())).not.toContain('exam_search');
  });

  it('冷却中的不出', () => {
    const s = state({ nextJobs: jobs('平安') });
    expect(ids('S29', s, new Set(['feat_batch']))).not.toContain('batch');
    expect(ids('S26', s, new Set(['feat_batch']))).toContain('batch');
  });

  it('S26 没模型时配合位是起头；同一个起头下一轮不再出（每轮 ≤1）', async () => {
    const s = state({ nextJobs: jobs('平安') });
    const row = await buildSuggestions(s, { last_user: '你还能帮我做什么？' }, null);
    expect(row.map(c => c.stance)).toEqual(['agree', 'hesitate', 'correct']);
    expect(row[0]).toMatchObject({ mode: 'start', action: { type: 'start_feature' } });
    resetSuggestMemory();
    const a = await buildSuggestions(s, { last_assistant: '好的。' }, null);
    expect(a.filter(c => c.action?.type === 'start_feature').length).toBeLessThanOrEqual(1);
    const shown = a.find(c => c.action?.type === 'start_feature')?.seed_id;
    const b = await buildSuggestions(s, { last_assistant: '好的。' }, null);
    expect(b.some(c => c.seed_id === shown)).toBe(false);
  });

  it('S26 模型按立场各写一个起头时，三条都是起头（S26 不受"两个起头只留一个"限制）', async () => {
    const row = (text: string, target: string) => [text, 'start_feature', target];
    const out = { 配合: [row('丢个平安的岗位给你看值不值', 'job_evaluate')], 犹豫: [row('看看哪些方向适合我', 'direction_explore')], 纠正: [row('我是想查平安靠谱吗', 'company_research:平安')] };
    const llm: LLM = { complete: vi.fn(async () => ({ text: JSON.stringify(out), usage: { input_tokens: 1, output_tokens: 1 } })) };
    const chips = await buildSuggestions(state({ nextJobs: jobs('平安') }), { last_user: '你还能帮我做什么？', last_assistant: '能帮你投平安这些岗位，也能看方向。' }, llm);
    expect(chips.map(c => c.stance)).toEqual(['agree', 'hesitate', 'correct']);
    expect(chips.every(c => c.mode === 'start' && c.action?.type === 'start_feature')).toBe(true);
  });
});
