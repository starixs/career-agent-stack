/**
 * 邮件投递工作台的纯逻辑：右边那一列的排法、开始条一家只默认勾一个岗、四步路停在哪、示例不像真的。
 */
import { describe, expect, it } from 'vitest';

import { READY_ROWS, REPLIED_ROWS, SENT_ROWS, WAITING_ROWS, WRITING_ROWS } from './boardFixtures';
import { applicationRows, defaultReadyPicks, isTrouble, stepsOf } from './mailBoard';
import { SAMPLE_DRAFT, SAMPLE_ROWS, SAMPLE_THREADS } from './sampleBoard';

describe('邮件投递工作台', () => {
  it('右边一列：不含可以投的；等他过目的排最前，其余保持服务端顺序', () => {
    const rows = applicationRows([...SENT_ROWS, ...READY_ROWS, ...WAITING_ROWS, ...REPLIED_ROWS]);
    expect(rows.map(r => r.station)).toEqual([...WAITING_ROWS.map(() => 'waiting'), ...SENT_ROWS.map(() => 'sent'), ...REPLIED_ROWS.map(() => 'replied')]);
    expect(rows.some(r => r.station === 'ready')).toBe(false);
  });

  it('开始条：一家公司默认只勾一个岗', () => {
    expect([...defaultReadyPicks(READY_ROWS)]).toEqual(['r_xhs', 'r_dw', 'r_al']);
  });

  it('被退回、没发出去的带红点', () => {
    expect(WAITING_ROWS.filter(isTrouble).map(r => r.key)).toEqual(['a_bo', 'a_hw']);
  });

  it('四步路：在写停在写邮件；投递待发停在等你过目；回信、再争取和已发出四步都走过了', () => {
    expect(stepsOf(WRITING_ROWS[0])).toEqual(['done', 'now', 'todo', 'todo']);
    expect(stepsOf(WAITING_ROWS[0])).toEqual(['done', 'done', 'ask', 'todo']);
    expect(stepsOf(WAITING_ROWS[1])).toEqual(['done', 'done', 'done', 'done']);
    expect(stepsOf(SENT_ROWS[0])).toEqual(['done', 'done', 'done', 'done']);
  });

  it('示例：每一份都有能摆出来的内容；邮箱都是 example.com，没有真实公司的标志', () => {
    for (const row of SAMPLE_ROWS) {
      expect(row.company.logo, row.key).toBeUndefined();
      const hasContent = row.action_id === SAMPLE_DRAFT.action_id || !!(row.application_id && SAMPLE_THREADS[row.application_id]) || row.station === 'writing';
      expect(hasContent, row.key).toBe(true);
    }
    const addresses = [SAMPLE_DRAFT.to, SAMPLE_DRAFT.from?.address ?? '', ...Object.values(SAMPLE_THREADS).flatMap(t => t.items.map(i => i.counterpart))];
    expect(addresses.every(a => a.endsWith('@example.com'))).toBe(true);
  });
});
