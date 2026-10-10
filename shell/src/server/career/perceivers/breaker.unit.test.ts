import { beforeEach, describe, expect, it } from 'vitest';

import { breakerState, resetBreakers, withBreaker } from './breaker';

describe('withBreaker', () => {
  beforeEach(() => resetBreakers());

  it('连续失败两次熔断：之后立刻失败、不再调用；冷却后试探成功就恢复', async () => {
    let t = 0; let calls = 0; let broken = true;
    const f = withBreaker('ocr', async () => { calls++; if (broken) throw new Error('crash'); return 'ok'; }, { now: () => t, cooldownMs: 1000 });
    await expect(f()).rejects.toThrow('crash');
    await expect(f()).rejects.toThrow('crash');
    expect(breakerState('ocr')).toEqual({ failures: 2, tripped: true });
    await expect(f()).rejects.toThrow('已熔断');
    expect(calls).toBe(2);
    t = 1500; broken = false;
    await expect(f()).resolves.toBe('ok');
    expect(breakerState('ocr')).toEqual({ failures: 0, tripped: false });
  });

  it('偶尔失败一次不熔断，成功会清零', async () => {
    let fail = true;
    const f = withBreaker('ocr2', async () => { if (fail) throw new Error('x'); return 1; });
    await expect(f()).rejects.toThrow();
    fail = false;
    await expect(f()).resolves.toBe(1);
    expect(breakerState('ocr2').failures).toBe(0);
  });
});
