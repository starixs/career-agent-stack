import { describe, expect, it } from 'vitest';

import { gateFrame, stableAspect, type FrameGate } from './CareerLiveViewport';

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

describe('gateFrame', () => {
  it('ignores a short burst of frames with another shape (window clipped vs full-viewport snapshot)', () => {
    let g: FrameGate = { aspect: null, pending: null };
    const step = (aspect: number, now: number) => { const r = gateFrame(g, aspect, now); g = r.gate; return r.show; };
    expect(step(1366 / 680, 0)).toBe(true);            // 第一帧：直接显示
    expect(step(1366 / 682, 40)).toBe(true);           // 几像素出入：照常
    expect(step(1366 / 1100, 80)).toBe(false);         // 突然一高一矮：先不换
    expect(step(1366 / 1100, 120)).toBe(false);
    expect(step(1366 / 680, 160)).toBe(true);          // 回到原比例：那两帧被吞掉，画面没跳
    expect(g.pending).toBeNull();
  });

  it('switches once the new shape is confirmed by consecutive frames or after a second', () => {
    let g: FrameGate = { aspect: 1.5, pending: null };
    const step = (aspect: number, now: number) => { const r = gateFrame(g, aspect, now); g = r.gate; return r.show; };
    expect(step(1.2, 0)).toBe(false);
    expect(step(1.2, 30)).toBe(false);
    expect(step(1.2, 60)).toBe(true);                  // 连续 3 帧：真的换了（用户拖了面板）
    expect(g.aspect).toBe(1.2);
    g = { aspect: 1.5, pending: null };
    expect(step(1.2, 0)).toBe(false);
    expect(step(1.2, 1200)).toBe(true);                // 静止页每 2 秒一张补帧：等满 1 秒也认
  });
});
