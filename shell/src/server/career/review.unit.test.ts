import { isSendNote } from '@career/core';
import { describe, expect, it } from 'vitest';

import { ownBaseline, weekFacts } from './review';

const WEEK = Date.parse('2026-10-19T00:00:00Z');
const h = (application_id: string, to_stage: string, created_at: string, note: string | null = null) => ({ application_id, from_stage: null, to_stage, note, created_at });

describe('weekFacts', () => {
  it('本周投出按第一次真正投出的时刻数：只评估没投的、邮件补建的、上周投的都不算；拒信和推进只数本周发生的', () => {
    const history = [
      h('a', 'evaluated', '2026-10-01T00:00:00Z'), h('a', 'applied', '2026-10-01T01:00:00Z', '已投递'), h('a', 'rejected', '2026-10-20T00:00:00Z', '收到拒信'),
      h('b', 'evaluated', '2026-10-20T00:00:00Z'), h('b', 'applied', '2026-10-20T01:00:00Z', '已投递'),
      h('c', 'evaluated', '2026-10-21T00:00:00Z'),
      h('d', 'evaluated', '2026-10-21T00:00:00Z'), h('d', 'applied', '2026-10-21T01:00:00Z', '自动推进（收到面试邀请）'), h('d', 'interview', '2026-10-21T01:00:00Z', '收到面试邀请'),
      h('e', 'applied', '2026-09-20T00:00:00Z', '已投递'), h('e', 'interview', '2026-09-30T00:00:00Z'), h('e', 'interview', '2026-10-20T00:00:00Z', '二面'),
    ];
    expect(weekFacts(history, WEEK, isSendNote, 7, 1)).toEqual({ applied: 1, advanced: 1, rejected: 1, silent: 7, interviews: 1 });
  });
});

describe('ownBaseline', () => {
  const overall = { key: 'all', total: 150, applied: 140, responded: 2, interview: 2, offer: 0, rejected: 31, silent: 50 };
  it('有自己的历史就用自己的：几份换一个面试、多久有回音', () => {
    expect(ownBaseline(overall, { first_interview_after: 52, reply_days: 8 })).toBe('他自己的基数（全部历史）：累计投出 140 份，走到面试 2 份；第一次进面试前投出了 52 份；投出到第一次有进展的中位数 8 天');
  });
  it('还没进过面试：不编一个比例', () => {
    expect(ownBaseline({ ...overall, interview: 0 }, { first_interview_after: null, reply_days: null })).toContain('还没有进过面试');
  });
});
