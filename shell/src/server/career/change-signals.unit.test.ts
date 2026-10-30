import type { Deadline, StageHistoryRow } from '@career/core';
import { describe, expect, it } from 'vitest';

import { changeSignals } from './change-signals';

const NOW = '2026-10-23T04:00:00.000Z';
const h = (application_id: string, to_stage: string, created_at: string): StageHistoryRow => ({ application_id, from_stage: null, to_stage, note: null, created_at });
const exam = (application_id: string) => ({ id: `d-${application_id}`, kind: 'written_test', status: 'open', application_id }) as Deadline;

function sent(n: number, title: string, prefix: string) {
  const apps = Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, job: { title } }));
  return { apps, history: apps.map(a => h(a.id, 'applied', '2026-09-20T00:00:00Z')) };
}

describe('changeSignals', () => {
  it('某类投出 30 份没有一份进笔试 → 提换方向；有一份进了笔试就不提', () => {
    const ops = sent(30, '新媒体运营', 'o');
    expect(changeSignals({ ...ops, deadlines: [], nowIso: NOW })).toEqual([{ tool: 'direction_explore', text: '「运营」类投出 30 份，没有一份进笔试' }]);
    expect(changeSignals({ ...ops, deadlines: [exam('o3')], nowIso: NOW })).toEqual([]);
    expect(changeSignals({ ...sent(29, '新媒体运营', 'o'), deadlines: [], nowIso: NOW })).toEqual([]);
  });

  it('最近连续 3 封拒信都挂在面试 → 提补短板；挂在简历关的不算', () => {
    const { apps, history } = sent(5, '后端开发', 'b');
    const iv = ['b0', 'b1', 'b2'].flatMap((id, i) => [h(id, 'interview', `2026-10-0${i + 1}T00:00:00Z`), h(id, 'rejected', `2026-10-1${i + 1}T00:00:00Z`)]);
    expect(changeSignals({ apps, history: [...history, ...iv], deadlines: [], nowIso: NOW })).toEqual([{ tool: 'gap_plan', text: '最近 3 封拒信都挂在面试' }]);
    const resume = ['b0', 'b1', 'b2'].map((id, i) => h(id, 'rejected', `2026-10-1${i + 1}T00:00:00Z`));
    expect(changeSignals({ apps, history: [...history, ...resume], deadlines: [], nowIso: NOW })).toEqual([]);
  });

  it('拒信当天不提', () => {
    const { apps, history } = sent(5, '后端开发', 'b');
    const iv = ['b0', 'b1', 'b2'].flatMap((id, i) => [h(id, 'interview', '2026-10-01T00:00:00Z'), h(id, 'rejected', `2026-10-2${i + 1}T00:00:00Z`)]);
    expect(changeSignals({ apps, history: [...history, ...iv], deadlines: [], nowIso: NOW })).toEqual([]);
  });
});
