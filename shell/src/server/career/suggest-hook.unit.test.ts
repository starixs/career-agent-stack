import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAREER_SUGGEST_EVENT, parseSuggestPush, type SuggestChip, type SuggestRequest } from '../../shared/careerSuggest';
import type { PostTurnSuggestContext } from '../turn-hooks';
import type { SuggestOptions, SuggestResult } from './suggest';
import type { SuggestState } from './suggest-context';
import { state } from './suggest-fixtures';
import type { LLM } from '@career/core';
import { createCareerSuggestHook, hookRequestOf, turnContextOf, type SuggestHookDeps } from './suggest-hook';

const CHIP: SuggestChip = { text: '先投招商银行', slot: 'next', kind: 'say', mode: 'advance', seed_id: null };
const STATE: SuggestState = state();
/** 只当"有模型"的标记：生成器被 mock，不会真调。 */
const LLM_STUB: LLM = { complete: async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } }) };

function ctxOf(over: Partial<PostTurnSuggestContext> = {}): PostTurnSuggestContext {
  return {
    sessionId: 's1', turnId: 't2', assistantMessageId: 'a2', rootUserMessageId: 'u2',
    assistantText: '好，我先看看招商银行。', startedAt: Date.parse('2026-11-05T10:00:00Z'),
    messages: [
      { id: 'u1', role: 'user', timestamp: '2026-11-05T07:00:00Z', content: '你好' },
      { id: 'a1', role: 'assistant', timestamp: '2026-11-05T07:00:05Z', content: [{ type: 'text', text: '你好呀' }] },
      { id: 'u2', role: 'user', timestamp: '2026-11-05T10:00:00Z', content: '<system-reminder>隐藏</system-reminder>帮我投招商银行' },
      { id: 'a2', role: 'assistant', timestamp: '2026-11-05T10:00:03Z', content: [
        { type: 'tool_use', tool: { name: 'mcp__career__job_search' } },
        { type: 'tool_use', tool: { name: 'mcp__career__job_search' } },
        { type: 'tool_use', tool: { name: 'batch_propose' } },
        { type: 'text', text: '好，我先看看招商银行。' },
      ] },
    ],
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function depsOf(over: Partial<SuggestHookDeps> = {}) {
  const broadcast = vi.fn();
  const generate = vi.fn(async (_s: SuggestState, _r: SuggestRequest, _l: LLM | null): Promise<SuggestResult> => ({ chips: [CHIP], scene: 'S14' }));
  const deps: SuggestHookDeps = {
    productSessionId: () => 's1',
    load: async () => ({ state: STATE, cards: ['batch_pick'] }),
    generate,
    llm: () => LLM_STUB,
    broadcast,
    budgetMs: 50,
    now: () => 1_000,
    ...over,
  };
  return { deps, broadcast, generate };
}

describe('turnContextOf', () => {
  it('取本轮他说的（去隐藏上下文）、小芽说的、工具去前缀去重、最近几轮、隔了几小时', () => {
    const t = turnContextOf(ctxOf());
    expect(t.user).toBe('帮我投招商银行');
    expect(t.assistant).toBe('好，我先看看招商银行。');
    expect(t.tools).toEqual(['job_search', 'batch_propose']);
    expect(t.turns.map(x => x.text)).toEqual(['你好', '你好呀', '帮我投招商银行', '好，我先看看招商银行。']);
    expect(t.away_hours).toBe(3);
  });

  it('旧路径没有 rootUserMessageId：按最后一句他说的话切本轮；回复文本缺省时用投影里的文字', () => {
    const t = turnContextOf(ctxOf({ rootUserMessageId: null, assistantText: '' }));
    expect(t.user).toBe('帮我投招商银行');
    expect(t.assistant).toBe('好，我先看看招商银行。');
  });

  it('请求带 this_turn 与 source=hook', () => {
    const req: SuggestRequest = hookRequestOf(turnContextOf(ctxOf()), ['batch_pick']);
    expect(req.this_turn).toEqual({ user: '帮我投招商银行', assistant: '好，我先看看招商银行。', tools: ['job_search', 'batch_propose'], cards: ['batch_pick'] });
    expect(req.source).toBe('hook');
  });
});

describe('createCareerSuggestHook', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('求职会话：发 career:suggest，载荷过 parseSuggestPush', async () => {
    const { deps, broadcast, generate } = depsOf();
    await createCareerSuggestHook(deps)(ctxOf());
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[1]).toMatchObject({ source: 'hook', this_turn: { cards: ['batch_pick'] } });
    expect(broadcast).toHaveBeenCalledOnce();
    const [event, payload] = broadcast.mock.calls[0] ?? [];
    expect(event).toBe(CAREER_SUGGEST_EVENT);
    expect(parseSuggestPush(payload)).toEqual({
      sessionId: 's1', turn_id: 't2', assistant_message_id: 'a2', chips: [CHIP], scene: 'S14', source: 'hook', degraded: false, ts: 1_000,
    });
  });

  it('非求职会话不发、不算', async () => {
    const { deps, broadcast, generate } = depsOf({ productSessionId: () => 'other' });
    await createCareerSuggestHook(deps)(ctxOf());
    expect(generate).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('同一条回复只发一次', async () => {
    const { deps, broadcast } = depsOf();
    const hook = createCareerSuggestHook(deps);
    await hook(ctxOf());
    await hook(ctxOf());
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('新一轮完成后旧结果不发（generation）', async () => {
    const slow = deferred<SuggestResult>();
    const generate = vi.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => ({ chips: [CHIP], scene: 'S3' }));
    const { deps, broadcast } = depsOf({ generate, budgetMs: 10_000 });
    const hook = createCareerSuggestHook(deps);
    const first = hook(ctxOf());
    await hook(ctxOf({ turnId: 't3', assistantMessageId: 'a3' }));
    slow.resolve({ chips: [CHIP], scene: 'S14' });
    await first;
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ assistant_message_id: 'a3', scene: 'S3' });
  });

  it('他又说了一句（isSuperseded）：旧结果不发', async () => {
    const { deps, broadcast } = depsOf();
    await createCareerSuggestHook(deps)(ctxOf(), () => true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('超时仍发：改用不叫模型的兜底，degraded=true', async () => {
    const generate = vi.fn((_s: SuggestState, _r: SuggestRequest, llm: unknown) =>
      (llm ? new Promise<SuggestResult>(() => undefined) : Promise.resolve({ chips: [CHIP], scene: 'S29' as const })));
    const { deps, broadcast } = depsOf({ generate, budgetMs: 5 });
    await createCareerSuggestHook(deps)(ctxOf());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[2]).toBeNull();
    expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ degraded: true, scene: 'S29' });
  });

  it('超时那次迟到也不进记忆：它的 isStale 变 true，兜底那次不 stale；都带会话 id', async () => {
    const opts: SuggestOptions[] = [];
    const generate = vi.fn((_s: SuggestState, _r: SuggestRequest, llm: unknown, o: SuggestOptions) => {
      opts.push(o);
      return llm ? new Promise<SuggestResult>(() => undefined) : Promise.resolve({ chips: [CHIP], scene: 'S29' as const });
    });
    const { deps } = depsOf({ generate, budgetMs: 5 });
    await createCareerSuggestHook(deps)(ctxOf());
    expect(opts.map(o => o.sessionId)).toEqual(['s1', 's1']);
    expect(opts[0]?.isStale?.()).toBe(true);
    expect(opts[1]?.isStale?.()).toBe(false);
  });

  it('被新一轮顶掉：生成器看到 isStale=true', async () => {
    let seen: boolean | undefined;
    const generate = vi.fn(async (_s: SuggestState, _r: SuggestRequest, _l: LLM | null, o: SuggestOptions) => {
      seen = o.isStale?.();
      return { chips: [CHIP], scene: 'S14' as const };
    });
    const { deps } = depsOf({ generate });
    await createCareerSuggestHook(deps)(ctxOf(), () => true);
    expect(seen).toBe(true);
  });

  it('没有模型也发，标 degraded', async () => {
    const { deps, broadcast } = depsOf({ llm: () => null });
    await createCareerSuggestHook(deps)(ctxOf());
    expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ degraded: true });
  });

  it('取状态失败：不抛、不发、记 FAILED', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps, broadcast } = depsOf({ load: async () => { throw new Error('db closed'); } });
    await expect(createCareerSuggestHook(deps)(ctxOf())).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[career-suggest] hook FAILED session=s1 turn=t2'), 'db closed');
  });
});
