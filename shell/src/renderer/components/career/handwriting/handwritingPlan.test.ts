import { describe, expect, it } from 'vitest';

import { ALL_QUOTES, parseQuotes, pickQuote, planWriting, splitClauses } from './handwritingPlan';
import type { QuoteScene, StrokeData } from './handwritingPlan';
import strokes from './strokes.json';

const SCENES: QuoteScene[] = ['daily', 'done', 'quiet', 'setback', 'start'];
const CJK = /[\u3400-\u9fff]/u;

const fakeData: StrokeData = {
  一: { m: [['M0 0L100 0', 100]] },
  二: { m: [['M0 0L100 0', 100], ['M0 0L900 0', 900]] },
};

describe('quotes', () => {
  it('has stroke data for every Chinese character, so no quote falls back to plain text', () => {
    const missing = ALL_QUOTES.flatMap(q => [...q.text]).filter(ch => CJK.test(ch) && !(ch in strokes));
    expect(missing, '改了 quotes.json 后运行 node scripts/build-handwriting-strokes.mjs').toEqual([]);
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
});

describe('planWriting', () => {
  it('writes strokes one after another, longer strokes taking longer', () => {
    const glyph = planWriting('二', fakeData).glyphs[0];
    if (glyph.kind !== 'pen') throw new Error('expected a pen glyph');
    const [first, second] = glyph.strokes;
    expect(second.delayMs).toBeGreaterThanOrEqual(first.delayMs + first.durationMs);
    expect(second.durationMs).toBeGreaterThan(first.durationMs);
  });

  it('draws commas as narrow pen strokes and pauses after them like taking a breath', () => {
    const plain = planWriting('一一', fakeData).glyphs;
    const paused = planWriting('一，一', fakeData).glyphs;
    const startOf = (g: (typeof plain)[number]) => (g.kind === 'pen' ? g.strokes[0].delayMs : g.delayMs);
    expect(paused[1]).toMatchObject({ kind: 'pen', ch: '，', narrow: true });
    expect(startOf(paused[2])).toBeGreaterThan(startOf(plain[1]) + 150);
  });

  it('fades in punctuation it cannot draw', () => {
    expect(planWriting('一！', fakeData).glyphs[1]).toMatchObject({ kind: 'text', ch: '！' });
  });

  it('gives each character a small, repeatable hand-written wobble', () => {
    const a = planWriting('一二一二', fakeData).glyphs;
    const b = planWriting('一二一二', fakeData).glyphs;
    expect(a).toEqual(b);
    const wobbles = a.flatMap(g => (g.kind === 'pen' ? [g.wobble] : []));
    expect(new Set(wobbles.map(w => w.rotate)).size).toBeGreaterThan(1);
    for (const w of wobbles) {
      expect(Math.abs(w.rotate)).toBeLessThanOrEqual(4);
      expect(w.scale).toBeGreaterThanOrEqual(0.93);
      expect(w.scale).toBeLessThanOrEqual(1.05);
    }
  });

  it('only breaks lines after clause punctuation', () => {
    const clauses = splitClauses([...'一二，一二。'].map(ch => ({ ch })));
    expect(clauses.map(c => c.map(g => g.ch).join(''))).toEqual(['一二，', '一二。']);
  });
});
