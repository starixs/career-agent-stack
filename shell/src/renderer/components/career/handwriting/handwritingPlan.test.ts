import { describe, expect, it } from 'vitest';

import { ALL_QUOTES, parseQuotes, pickQuote, planWriting, splitClauses } from './handwritingPlan';
import type { QuoteScene, StrokeData } from './handwritingPlan';
import strokes from './strokes.json';

const SCENES: QuoteScene[] = ['daily', 'done', 'quiet', 'setback', 'start'];
const CJK = /[㐀-鿿]/u;

const fakeData: StrokeData = {
  一: { s: ['M0 0Z'], m: [['M0 0L100 0', 100]] },
  二: { s: ['M0 0Z', 'M0 0Z'], m: [['M0 0L100 0', 100], ['M0 0L300 0', 300]] },
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
    if (glyph.kind !== 'hanzi') throw new Error('expected a hanzi glyph');
    const [first, second] = glyph.strokes;
    expect(second.delayMs).toBeGreaterThanOrEqual(first.delayMs + first.durationMs);
    expect(second.durationMs).toBeGreaterThan(first.durationMs);
  });

  it('pauses at punctuation longer than between characters', () => {
    const plain = planWriting('一一', fakeData).glyphs;
    const paused = planWriting('一，一', fakeData).glyphs;
    const startOf = (g: (typeof plain)[number]) => (g.kind === 'hanzi' ? g.strokes[0].delayMs : g.delayMs);
    expect(startOf(paused[2])).toBeGreaterThan(startOf(plain[1]) + 150);
    expect(paused[1]).toMatchObject({ kind: 'text', ch: '，' });
  });

  it('only breaks lines after clause punctuation', () => {
    const clauses = splitClauses([...'一二，一二。'].map(ch => ({ ch })));
    expect(clauses.map(c => c.map(g => g.ch).join(''))).toEqual(['一二，', '一二。']);
  });
});
