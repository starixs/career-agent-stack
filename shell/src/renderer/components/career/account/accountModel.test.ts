import { describe, expect, it } from 'vitest';

import { fillDays, groupUsage, txnLabel, yuan, type UsageBucket } from './accountModel';

const b = (p: Partial<UsageBucket>): UsageBucket => ({ origin: 'chat', kind: 'llm', name: 'deepseek-v4-flash', calls: 1, credits: 0, unpricedCalls: 0, ...p });

describe('accountModel', () => {
  it('用量归成对话 / 后台 / 搜索 / 其他，花得多的在前', () => {
    const groups = groupUsage([
      b({ credits: 3, calls: 4 }),
      b({ origin: 'background', credits: 9, calls: 20 }),
      b({ origin: 'tool', kind: 'tool', name: 'search:bocha', credits: 2, calls: 2 }),
      b({ origin: 'tool', kind: 'tool', name: 'search:tavily', credits: 1, calls: 1 }),
      b({ origin: 'tool', kind: 'tool', name: 'web_fetch', credits: 0, calls: 5 }),
    ]);
    expect(groups.map(g => [g.id, g.credits, g.calls])).toEqual([['background', 9, 20], ['chat', 3, 4], ['search', 3, 3], ['other', 0, 5]]);
  });

  it('流水叫法：有描述用描述，否则按来源', () => {
    expect(txnLabel({ id: '1', type: 'earn', amount: 50, balance_after: 50, source_type: 'signup', description: null, created_at: '' })).toBe('开户赠送');
    expect(txnLabel({ id: '2', type: 'spend', amount: -1, balance_after: 49, source_type: 'llm_usage', description: '对话用量', created_at: '' })).toBe('对话用量');
  });

  it('金额与补齐天数', () => {
    expect(yuan(3900)).toBe('¥39');
    expect(yuan(20)).toBe('¥0.2');
    const days = fillDays([{ day: '2026-11-04', credits: 7, calls: 3 }], 3, new Date('2026-11-05T12:00:00Z'));
    expect(days).toEqual([{ day: '2026-11-03', credits: 0 }, { day: '2026-11-04', credits: 7 }, { day: '2026-11-05', credits: 0 }]);
  });
});
