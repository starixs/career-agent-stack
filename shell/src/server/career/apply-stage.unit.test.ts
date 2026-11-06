import { describe, expect, it } from 'vitest';

import { ApplyProgressTracker, stageOfProgress } from './apply-stage';

describe('进度事件 → 走到链路哪一环、格子填了多少（2026-11-06 界面改成画图，不靠句子）', () => {
  it('按引擎进度的类别认是哪一环；认不出的不动', () => {
    expect(stageOfProgress({ kind: 'resume' })).toBe('tailor');
    expect(stageOfProgress({ kind: 'entry' })).toBe('open');
    expect(stageOfProgress({ phase: 'navigate' })).toBe('open');
    expect(stageOfProgress({ kind: 'field' })).toBe('fill');
    expect(stageOfProgress({ kind: 'stop' })).toBe('review');
    expect(stageOfProgress({ phase: 'drive' })).toBeUndefined();
  });

  it('一趟之内只往前走：填到一半关了个弹窗、又进了一次入口，不会退回「打开网页」', () => {
    const t = new ApplyProgressTracker('picked');
    for (const ev of [{ kind: 'resume' }, { phase: 'navigate' }, { kind: 'page', total: 26 }, { kind: 'field', label: '姓名' }, { kind: 'entry' }]) t.add(ev);
    expect(t.stage).toBe('fill');
  });

  it('边填边数：每页找到几格加起来，动过的格子按名字去重；收尾用引擎的逐格结果校准', () => {
    const t = new ApplyProgressTracker('picked');
    expect(t.cells()).toBeUndefined();
    t.add({ kind: 'page', total: 26 });
    for (const label of ['姓名', '邮箱', '姓名']) t.add({ kind: 'field', label });
    expect(t.cells()).toEqual({ total: 26, done: 2, you: 0 });
    t.settle({ fields: [{ status: 'verified' }, { status: 'prefilled' }, { status: 'needs_user' }, { status: 'draft' }, { status: 'empty_optional' }, { status: 'skipped' }] });
    // 选填留空、跳过的不算在格子里
    expect(t.cells()).toEqual({ total: 4, done: 2, you: 2 });
  });
});
