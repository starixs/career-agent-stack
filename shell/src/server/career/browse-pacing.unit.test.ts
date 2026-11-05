import { describe, expect, it } from 'vitest';

import { actionDelayMs } from './browse-pacing';

describe('browser action pacing', () => {
  it('重复同一动作降速，且不是固定 sleep', () => {
    expect(actionDelayMs({ baseMs: 1000, repeated: true, burstCount: 2, rand: () => 0.5 })).toBe(1500);
    expect(actionDelayMs({ baseMs: 1000, repeated: false, burstCount: 2, rand: () => 0.5 })).toBe(1000);
  });

  it('连续 12 个动作后插入有边界的停顿', () => {
    expect(actionDelayMs({ baseMs: 1000, repeated: false, burstCount: 12, rand: () => 0 })).toBe(4000);
    expect(actionDelayMs({ baseMs: 1000, repeated: false, burstCount: 12, rand: () => 0.999 })).toBeLessThanOrEqual(6998);
  });
});
