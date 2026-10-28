import { describe, expect, it } from 'vitest';

import { monthQuoteScene } from './monthQuoteScene';

describe('monthQuoteScene', () => {
  it('celebrates an offer before anything else', () => {
    expect(monthQuoteScene({ counts: [30, 4, 2, 1], in_transit: 20 })).toBe('funnel-offer');
  });

  it('cheers on written tests and interviews in progress', () => {
    expect(monthQuoteScene({ counts: [30, 1, 0, 0], in_transit: 2 })).toBe('funnel-interview');
    expect(monthQuoteScene({ counts: [30, 0, 3, 0], in_transit: 2 })).toBe('funnel-interview');
  });

  it('starts from the beginning when nothing has been sent this month', () => {
    expect(monthQuoteScene({ counts: [0, 0, 0, 0], in_transit: 0 })).toBe('funnel-start');
  });

  it('tells waiting from setback by how many applications are still out', () => {
    expect(monthQuoteScene({ counts: [20, 0, 0, 0], in_transit: 15 })).toBe('funnel-waiting');
    expect(monthQuoteScene({ counts: [20, 0, 0, 0], in_transit: 10 })).toBe('funnel-waiting');
    expect(monthQuoteScene({ counts: [20, 0, 0, 0], in_transit: 4 })).toBe('funnel-setback');
  });
});
