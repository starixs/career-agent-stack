/**
 * 邮件投递工作台的纯逻辑：右边那一列的排法、开始条一家只默认勾一个岗、四步路停在哪、第一次打开的预设那封不像真的。
 */
import { describe, expect, it } from 'vitest';

import { READY_ROWS, REPLIED_ROWS, SENT_ROWS, WAITING_ROWS, WRITING_ROWS } from './boardFixtures';
import { applicationRows, defaultReadyPicks, isTrouble, stepsOf } from './mailBoard';
import { PRESET_COMPANY, PRESET_DRAFT } from './sampleBoard';

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

  it('第一次打开的预设那封：编的公司（没有真实公司的标志），邮箱都是 example.com，字里没有「示例」', () => {
    expect(PRESET_COMPANY.logo).toBeUndefined();
    expect([PRESET_DRAFT.to, PRESET_DRAFT.from?.address ?? ''].every(a => a.endsWith('@example.com'))).toBe(true);
    expect(JSON.stringify(PRESET_DRAFT)).not.toContain('示例');
  });
});
