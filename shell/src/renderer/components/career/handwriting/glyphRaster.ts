/**
 * 浏览器侧：把书法字形栅格化成墨点，再按楷体笔顺排出墨时间表（纯计算见 handwritingPlan.ts）。
 * 每个字算一次就缓存，同一会话里换场景、重渲染都不再算。没有 2D canvas 的环境返回 null，调用方退回纯文字。
 */
import { PUNCTUATION_STROKES, sampleMedian, scheduleGlyph } from './handwritingPlan';
import type { GlyphData, GlyphSchedule, InkPixel, StrokeData } from './handwritingPlan';

/** 每个字的栅格边长（像素）。显示时按字号缩放；120 在 2 倍屏 28px 下足够细。 */
export const RASTER_CELL = 120;
// 字形按字身框摆放（保留书法家原字的大小与位置），字身占格子的 92%。
const EM_FILL = 0.92;
// 不透明度低于这个值的抗锯齿边缘不算墨点，免得归笔时被噪点拖偏。
const INK_ALPHA_MIN = 8;

const scheduleCache = new Map<string, GlyphSchedule | null>();
let canvasSupport: boolean | null = null;

/** 本环境能不能用 2D canvas（测试用的 jsdom 不能）；只探测一次，免得每个字都去试。 */
export function canvas2dAvailable(): boolean {
  if (canvasSupport === null) {
    canvasSupport = typeof document !== 'undefined' && typeof Path2D !== 'undefined'
      && document.createElement('canvas').getContext('2d') !== null;
  }
  return canvasSupport;
}

function rasterGlyph(data: GlyphData, ch: string): Uint8ClampedArray | null {
  const glyph = data.glyphs[ch];
  if (!glyph || !canvas2dAvailable()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RASTER_CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const s = RASTER_CELL * EM_FILL / data.upm;
  ctx.setTransform(s, 0, 0, -s, (RASTER_CELL - glyph.adv * s) / 2, (RASTER_CELL - data.upm * s) / 2 + data.ascent * s);
  ctx.fill(new Path2D(glyph.d));
  return ctx.getImageData(0, 0, RASTER_CELL, RASTER_CELL).data;
}

function inkPixels(rgba: Uint8ClampedArray): InkPixel[] {
  const ink: InkPixel[] = [];
  for (let y = 0; y < RASTER_CELL; y++) {
    for (let x = 0; x < RASTER_CELL; x++) {
      const a = rgba[(y * RASTER_CELL + x) * 4 + 3];
      if (a > INK_ALPHA_MIN) ink.push({ x, y, a });
    }
  }
  return ink;
}

/** 一个字的出墨时间表；字形或笔顺数据缺失、或环境不支持 canvas 时返回 null。 */
export function glyphSchedule(ch: string, glyphs: GlyphData, strokes: StrokeData): GlyphSchedule | null {
  const cached = scheduleCache.get(ch);
  if (cached !== undefined) return cached;
  const medians = (strokes[ch] ?? PUNCTUATION_STROKES[ch])?.m.map(([path]) => sampleMedian(path));
  const rgba = medians ? rasterGlyph(glyphs, ch) : null;
  const schedule = rgba && medians ? scheduleGlyph(inkPixels(rgba), medians, RASTER_CELL) : null;
  // 环境不支持 canvas 时不缓存，换到支持的环境（或测试替身）还能重算。
  if (rgba || !medians) scheduleCache.set(ch, schedule);
  return schedule;
}
