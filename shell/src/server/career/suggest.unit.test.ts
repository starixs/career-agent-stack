import type { LLM } from '@career/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prePick } from './batch-propose';
import { buildSuggestions, cleanChip, resetSuggestMemory, SUGGEST_LLM_TIMEOUT_MS } from './suggest';
import { mainlineChip, seedCandidates, type SuggestContext } from './suggest-seeds';

const ctx = (over: Partial<SuggestContext> = {}): SuggestContext => ({
  stage: 'first', waiting: 0, hasResume: true, mailConnected: false, prefsText: '', ...over,
});
const llmReturning = (text: string): LLM => ({ complete: vi.fn(async () => ({ text, usage: { input_tokens: 1, output_tokens: 1 } })) });

describe('建议条', () => {
  beforeEach(() => resetSuggestMemory());

  it('接话在前，主线一条，种子一条', async () => {
    const chips = await buildSuggestions(ctx(), { last_assistant: '你想先投哪类？' }, llmReturning('{"replies":["财务类","运营类"],"seed":0}'));
    expect(chips.map(c => c.slot)).toEqual(['reply', 'reply', 'mainline', 'seed']);
    expect(chips[2].text).toBe('先投一家给我看看');
  });

  it('模型出错时只出规则那两格，不抛错', async () => {
    const llm: LLM = { complete: vi.fn(async () => { throw new Error('boom'); }) };
    const chips = await buildSuggestions(ctx(), { last_assistant: '好的' }, llm);
    expect(chips.map(c => c.slot)).toEqual(['mainline', 'seed']);
  });

  it('模型超时也只出规则那两格', async () => {
    vi.useFakeTimers();
    const llm: LLM = { complete: vi.fn(() => new Promise<never>(() => {})) };
    const pending = buildSuggestions(ctx(), { last_assistant: '好的' }, llm);
    await vi.advanceTimersByTimeAsync(SUGGEST_LLM_TIMEOUT_MS + 10);
    const chips = await pending;
    vi.useRealTimers();
    expect(chips.map(c => c.slot)).toEqual(['mainline', 'seed']);
  });

  it('底部有卡在等他拍板时不出主线那一条', async () => {
    const chips = await buildSuggestions(ctx(), { last_assistant: '好的', pending_cards: ['batch_pick'] }, null);
    expect(chips.some(c => c.slot === 'mainline')).toBe(false);
  });

  it('超长、带 JSON 残渣的建议丢掉', () => {
    expect(cleanChip('这是一句明显超过十六个字上限的很长很长的回复')).toBeNull();
    expect(cleanChip('{"a":1}')).toBeNull();
    expect(cleanChip('「好的」')).toBe('好的');
  });

  it('有事等他时，主线先带他去处理', () => {
    expect(mainlineChip(ctx({ waiting: 2 }))).toBe('先处理等我的事');
    expect(mainlineChip(ctx({ stage: 'batch' }))).toBe('再投 5 家');
    expect(mainlineChip(ctx({ stage: 'profile', hasResume: false }))).toBe('我还没有简历，先聊聊');
  });

  it('已有的数据不再收：连了邮箱就不出手投过 / 盯邮箱', () => {
    const ids = seedCandidates(ctx({ stage: 'first', mailConnected: true }), new Set()).map(s => s.id);
    expect(ids).not.toContain('mail_takeover');
    expect(ids).not.toContain('mail_connect');
  });

  it('同一条种子不会连着出', async () => {
    const first = await buildSuggestions(ctx(), {}, null);
    const second = await buildSuggestions(ctx(), {}, null);
    expect(first.at(-1)?.seed_id).not.toBe(second.at(-1)?.seed_id);
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
