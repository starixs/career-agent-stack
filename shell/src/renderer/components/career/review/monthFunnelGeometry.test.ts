import { describe, expect, it } from 'vitest';

import { GEO, bandClip, emptySlot, improvedRate, layerTop, rings, scaleBase, vase, widthOf } from './monthFunnelGeometry';

describe('月度漏斗几何', () => {
  it('宽度按本月投出折算，再小也看得见，太宽封顶', () => {
    expect(widthOf(156, 156)).toBe(GEO.FULL);
    expect(widthOf(2, 156)).toBe(GEO.MINW);
    expect(widthOf(0, 156)).toBe(0);
    expect(widthOf(5000, 10)).toBe(1400);
  });

  it('花瓶只往下收：肩部不鼓出顶边，每层正中等于该层宽度', () => {
    const v = vase([156, 31, 11, 2], 156)!;
    let last = Infinity;
    for (let y = GEO.Y0; y <= layerTop(3) + GEO.H; y += 2) {
      const hw = v.halfWidthAt(y);
      expect(hw).toBeLessThanOrEqual(last + 1e-6);
      last = hw;
    }
    expect(v.halfWidthAt(GEO.Y0)).toBeCloseTo(GEO.FULL / 2, 5);
    expect(v.halfWidthAt(layerTop(1) + GEO.H / 2)).toBeCloseTo(widthOf(31, 156) / 2, 5);
    expect(vase([0, 0, 0, 0], 10)).toBeNull();
  });

  it('投出为 0 时从第一个有数的层起画；比例尺取四层最大值', () => {
    // 这个月只有一份邮件补建的投递：投出 0、笔试 1
    expect(scaleBase([0, 1, 0, 0])).toBe(1);
    const v = vase([0, 1, 0, 0], scaleBase([0, 1, 0, 0]))!;
    expect(v).not.toBeNull();
    expect(v.d.startsWith(`M ${(GEO.CX - GEO.FULL / 2).toFixed(1)} ${layerTop(1)}`)).toBe(true);
    expect(v.halfWidthAt(layerTop(1) + GEO.H / 2)).toBeCloseTo(GEO.FULL / 2, 5);
    expect(emptySlot(0)).toContain(`${layerTop(0) + 12}`);
  });

  it('色带之间留纸缝，最后一层多留出收口', () => {
    const a = bandClip(0); const b = bandClip(1);
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect(bandClip(3).y + bandClip(3).height).toBeGreaterThan(layerTop(3) + GEO.H + 20);
  });

  it('年轮最多三圈，按月份标签排在右侧一列', () => {
    const r = rings([
      { key: '2026-11', month: 11, counts: [70, 12, 5, 1] },
      { key: '2026-10', month: 10, counts: [156, 31, 11, 2] },
      { key: '2026-09', month: 9, counts: [48, 14, 4, 0] },
      { key: '2026-08', month: 8, counts: [10, 2, 0, 0] },
    ], 110);
    expect(r.map((x) => x.label)).toEqual(['11 月', '10 月', '9 月']);
    expect(new Set(r.map((x) => x.text[0])).size).toBe(1);
    expect(r[0].style.stroke).toBeGreaterThan(r[2].style.stroke);
  });

  it('转化率：两个月上一层都满 10 份、而且变好才给', () => {
    expect(improvedRate([156, 31, 11, 2], [48, 14, 4, 0], 2)).toEqual({ now: 11 / 31, before: 4 / 14 });
    expect(improvedRate([156, 31, 11, 2], [48, 14, 4, 0], 1)).toBeNull();
    expect(improvedRate([70, 12, 5, 1], [156, 31, 11, 2], 3)).toBeNull();
    expect(improvedRate([156, 31, 11, 2], null, 2)).toBeNull();
    expect(improvedRate([156, 31, 11, 2], [48, 14, 4, 0], 0)).toBeNull();
  });
});
