import { describe, expect, it } from 'vitest';

import { mergedBatchIds } from '@/components/career/delivery/BatchWall';
import type { CareerCard } from '@/components/career/types';
import type { Message, ToolUseSimple } from '@/types/chat';

import { supersededInfoCards } from './supersede';

const toolOf = (id: string, name: string, input: Record<string, unknown>): ToolUseSimple => ({ id, name, input, parsedInput: input, inputJson: JSON.stringify(input), result: '{}', streamIndex: 0 });
const tool = (id: string, name: string, input: Record<string, unknown> = {}) => toolOf(id, `mcp__career__${name}`, input);
const reply = (...tools: ToolUseSimple[]): Message => ({ id: tools[0].id, role: 'assistant', timestamp: new Date(0), content: tools.map(t => ({ type: 'tool_use' as const, tool: t })) });

describe('同一个对象在对话里只出一张卡（2026-11-02：岗位清单连刷一屏）', () => {
  it('岗位清单查了几次只留最后一次；不同岗位的卡各自留；导出的文件每次都是新东西', () => {
    const msgs = [
      reply(tool('t1', 'jobs_board'), tool('t2', 'job_evaluate', { job_id: 'j1' })),
      reply(tool('t3', 'jobs_board', { keyword: '数据' }), tool('t4', 'job_evaluate', { job_id: 'j2' })),
      reply(tool('t5', 'resume_export'), tool('t6', 'resume_export'), tool('t7', 'jobs_sync')),
    ];
    expect([...supersededInfoCards(msgs)].sort()).toEqual(['t1', 't3']);
  });

  it('经 more_actions 调的也认得出是同一个对象', () => {
    const wrapped = (id: string) => toolOf(id, 'mcp__career__more_actions', { name: 'jobs_board', args: {} });
    expect([...supersededInfoCards([reply(wrapped('a')), reply(wrapped('b'))])]).toEqual(['a']);
  });
});

describe('批次墙：对话里只有一面，合起所有批次原地更新（2026-11-02：「投 1 家」逐家重复）', () => {
  const batch = (id: string, ids: string[]): CareerCard => ({ id, kind: 'review', title: '', createdAt: '', data: { kind: 'fill_form', action_ids: ids } });
  const cards = [batch('c1', ['a1']), { id: 'x', kind: 'tailor_diff', title: '', createdAt: '', data: {} } as CareerCard, batch('c2', ['a2', 'a1']), batch('c3', ['a3'])];
  it('前面的批次卡不出，最后一张带上全部申请（去重）', () => {
    expect(mergedBatchIds(cards, 'c1', ['a1'])).toBeNull();
    expect(mergedBatchIds(cards, 'c2', ['a2', 'a1'])).toBeNull();
    expect(mergedBatchIds(cards, 'c3', ['a3'])).toEqual(['a1', 'a2', 'a3']);
  });
  it('不在卡片集合里（单独渲染）就照自己的那批', () => {
    expect(mergedBatchIds(cards, undefined, ['z'])).toEqual(['z']);
  });
});
