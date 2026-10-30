import { describe, expect, it } from 'vitest';

import { cellCenter, gridOf, GRID_CELL_PX, TICK_PX } from './captcha-solver';

// 编号网格（Set-of-Mark）的换算：模型报格子号，代码换成坐标；端到端见 scripts/career-captcha-smoke.mjs。

describe('gridOf / cellCenter', () => {
  const region = { x: 100, y: 200, width: 300, height: 150 };
  it('点选：按 30px 一格分行列，格子号从 1 开始按行数', () => {
    const m = gridOf(300, 150, 'grid');
    expect(m).toMatchObject({ cols: 300 / GRID_CELL_PX, rows: 150 / GRID_CELL_PX });
    expect(cellCenter(m, 1, region)).toEqual({ x: 115, y: 215 });
    expect(cellCenter(m, m.cols + 1, region)).toEqual({ x: 115, y: 245 });
    expect(cellCenter(m, m.cols * m.rows, region)).toEqual({ x: 385, y: 335 });
  });
  it('越界或不是整数的格子号不换算（不瞎点）', () => {
    const m = gridOf(300, 150, 'grid');
    for (const n of [0, -1, 1.5, m.cols * m.rows + 1, Number.NaN]) expect(cellCenter(m, n, region)).toBeNull();
  });
  it('滑块：横向刻度每格 10px，只有一行', () => {
    expect(gridOf(300, 150, 'ticks')).toEqual({ kind: 'ticks', cols: 300 / TICK_PX, rows: 1, cell: TICK_PX });
  });
});
