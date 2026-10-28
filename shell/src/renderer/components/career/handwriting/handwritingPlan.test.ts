import { describe, expect, it } from 'vitest';

import glyphs from './glyphs.json';
import {
  ALL_QUOTES, LINE_SLOW_MS, LINE_TOTAL_MS, PUNCTUATION_STROKES, lineOffsets, makeWarp, parseQuotes, pickQuote, sampleMedian,
  scheduleGlyph, splitClauses, strokeEase,
} from './handwritingPlan';
import type { InkPixel, Point, QuoteScene } from './handwritingPlan';
import strokes from './strokes.json';

const SCENES: QuoteScene[] = ['daily', 'done', 'quiet', 'setback', 'start'];
const CJK = /[㐀-鿿]/u;

describe('quotes', () => {
  it('has a calligraphy glyph and a stroke order for every character, so no quote falls back to plain text', () => {
    const chars = [...new Set(ALL_QUOTES.flatMap(q => [...q.text]))];
    const noGlyph = chars.filter(ch => !(ch in glyphs.glyphs));
    const noOrder = chars.filter(ch => (CJK.test(ch) ? !(ch in strokes) : !(ch in PUNCTUATION_STROKES)));
    expect(noGlyph, '改了 quotes.json 后运行 python3 scripts/build-handwriting-glyphs.py').toEqual([]);
    expect(noOrder, '改了 quotes.json 后运行 node scripts/build-handwriting-strokes.mjs').toEqual([]);
  });

  it('gives every scene at least two lines to rotate through', () => {
    for (const scene of SCENES) expect(ALL_QUOTES.filter(q => q.scenes.includes(scene)).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a quote with an unknown scene and names it', () => {
    expect(() => parseQuotes([{ text: '好', tone: 'encourage', scenes: ['lunch'] }])).toThrow(/#0/);
  });

  it('picks the same line all day and lets a seed move it', () => {
    expect(pickQuote('daily', '2026-10-27')).toEqual(pickQuote('daily', '2026-10-27'));
    const seeds = new Set(['a', 'b', 'c', 'd', 'e'].map(seed => pickQuote('setback', '2026-10-27', seed).text));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('only breaks lines after clause punctuation', () => {
    const clauses = splitClauses([...'一二，一二。'].map(ch => ({ ch })));
    expect(clauses.map(c => c.map(g => g.ch).join(''))).toEqual(['一二，', '一二。']);
  });
});

describe('sampleMedian', () => {
  it('walks a smoothed centerline from start to end in roughly even steps', () => {
    const pts = sampleMedian('M0 0C100 0 200 0 300 0');
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([300, 0]);
    expect(pts.length).toBeGreaterThan(10);
  });

  it('refuses an empty path instead of producing a stroke with no points', () => {
    expect(() => sampleMedian('Z')).toThrow(/empty median/);
  });
});

describe('scheduleGlyph', () => {
  // 两笔横：上一横先写，下一横后写；墨迹是两条 6 像素粗的横条。
  const medians: Point[][] = [[[0, 900], [1000, 900]], [[0, 100], [1000, 100]]];
  const ink: InkPixel[] = [];
  for (let x = 10; x <= 110; x++) for (const y of [20, 21, 22, 23, 24, 25, 96, 97, 98, 99, 100, 101]) ink.push({ x, y, a: 255 });
  const events = scheduleGlyph(ink, medians, 120).events;
  const at = (x: number, y: number) => events.find(e => e.i === (y * 120 + x) * 4)?.t ?? NaN;

  it('inks strokes in stroke order and each stroke from its start to its end', () => {
    expect(at(110, 22)).toBeLessThan(at(10, 98));
    expect(at(10, 22)).toBeLessThan(at(110, 22));
  });

  it('lets ink spread outward: pixels away from the centerline arrive a little later', () => {
    // 这一横的墨迹 y = 20..25，拉伸对齐后中轴落在 y = 20，越往下离中轴越远
    expect(at(60, 25)).toBeGreaterThan(at(60, 20));
  });
});

describe('line rhythm', () => {
  it('pauses much longer after punctuation than between characters', () => {
    const plain = lineOffsets(['一', '二'], [100, 100]).offsets[1];
    const paused = lineOffsets(['，', '二'], [100, 100]).offsets[1];
    expect(paused - plain).toBeGreaterThanOrEqual(500);
  });

  it('starts at the natural pace, then speeds up to land the last stroke exactly at the total', () => {
    const natural = 20_000;
    const warp = makeWarp(natural);
    expect(warp(0)).toBe(0);
    expect(warp(1000)).toBeCloseTo(1000, 0);
    expect(warp(LINE_TOTAL_MS)).toBeCloseTo(natural, 0);
    const slowRate = warp(1000) - warp(900);
    const fastRate = warp(5000) - warp(4900);
    expect(fastRate).toBeGreaterThan(slowRate * 3);
    for (let r = 100; r <= LINE_TOTAL_MS; r += 100) expect(warp(r)).toBeGreaterThan(warp(r - 100));
  });

  it('spreads a short line evenly over the total when the slow part alone would finish it', () => {
    const warp = makeWarp(LINE_SLOW_MS);
    expect(warp(LINE_TOTAL_MS / 2)).toBeCloseTo(LINE_SLOW_MS / 2, 5);
  });

  it('keeps the ease monotonic with fixed ends', () => {
    expect(strokeEase(0)).toBe(0);
    expect(strokeEase(1)).toBeCloseTo(1, 10);
    for (let u = 0.05; u <= 1; u += 0.05) expect(strokeEase(u)).toBeGreaterThan(strokeEase(u - 0.05));
  });
});
