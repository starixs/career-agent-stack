import { describe, expect, it } from 'vitest';

import { stableAspect } from './CareerLiveViewport';

describe('stableAspect', () => {
  it('keeps the frame box still when live and still frames differ by a few pixels', () => {
    const a = stableAspect(null, 1366, 1000);
    expect(a).toBeCloseTo(1.366, 3);
    expect(stableAspect(a, 1366, 990)).toBe(a);   // ≈1% 出入：不动
    expect(stableAspect(a, 1360, 1000)).toBe(a);
  });

  it('follows a real change of the page viewport and ignores frames without a size', () => {
    const a = stableAspect(null, 1366, 1000);
    expect(stableAspect(a, 1366, 768)).toBeCloseTo(1366 / 768, 3);
    expect(stableAspect(a, 0, 0)).toBe(a);
    expect(stableAspect(null, undefined, undefined)).toBeNull();
  });
});
