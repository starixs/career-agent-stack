import { describe, expect, it } from 'vitest';

import { SUBMITTED_STAGES, isSubmittedStage } from './careerStages';

describe('投出去过的阶段', () => {
  it('applied 之后都算；pending（还没投出去）、放弃、跳过不算', () => {
    expect([...SUBMITTED_STAGES]).toEqual(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);
    expect(isSubmittedStage('rejected')).toBe(true);
    for (const s of ['pending', 'discarded', 'skip', 'blocked', 'needs_user', 'approved']) expect(isSubmittedStage(s)).toBe(false);
  });
});
