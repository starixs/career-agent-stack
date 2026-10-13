import { describe, expect, it } from 'vitest';

import { applicationStepper, type StepState } from './applicationSteps';

const states = (m: ReturnType<typeof applicationStepper>): StepState[] => m.steps.map(s => s.state);

describe('applicationStepper：投递阶段 → 网申 / 测评 / 笔试 / 面试 / Offer / 入职', () => {
  it('还没投出去：网申是当前一步，后面都没到', () => {
    const m = applicationStepper({ stage: 'approved', reached_stages: ['evaluated', 'ready', 'approved'] });
    expect(states(m)).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(m.label).toBe('网申 · 待投');
    expect(m.tone).toBe('neutral');
  });

  it('需要你 / 卡住：停在网申，warning', () => {
    const m = applicationStepper({ stage: 'needs_user' });
    expect(m.currentIndex).toBe(0);
    expect(m.label).toBe('网申 · 需要你');
    expect(m.tone).toBe('warning');
  });

  it('已投递、没有笔试测评记录：网申当前；有笔试安排：笔试当前，测评跳过', () => {
    expect(applicationStepper({ stage: 'applied', reached_stages: ['evaluated', 'applied'] }).label).toBe('网申 · 已投递');
    const m = applicationStepper({ stage: 'applied', reached_stages: ['applied'], exam_kinds: ['written_test'] });
    expect(states(m)).toEqual(['done', 'skipped', 'current', 'todo', 'todo', 'todo']);
    expect(m.label).toBe('笔试');
    expect(m.tone).toBe('accent');
  });

  it('面试中：之前没记录的测评 / 笔试标成跳过，不假装做过', () => {
    const m = applicationStepper({ stage: 'interview', reached_stages: ['applied', 'interview'], exam_kinds: ['assessment'] });
    expect(states(m)).toEqual(['done', 'done', 'skipped', 'current', 'todo', 'todo']);
    expect(m.label).toBe('面试');
  });

  it('Offer 与入职用 success；入职后全部完成', () => {
    expect(applicationStepper({ stage: 'offer', reached_stages: ['applied', 'interview', 'offer'] }).tone).toBe('success');
    const hired = applicationStepper({ stage: 'hired', reached_stages: ['applied', 'interview', 'offer', 'hired'], exam_kinds: ['assessment', 'written_test'] });
    expect(states(hired)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(hired.label).toBe('已入职');
  });

  it('被拒：停在走到过的最远一步画 ✗，后面没到；用中性色而不是红色', () => {
    const m = applicationStepper({ stage: 'rejected', reached_stages: ['applied', 'interview', 'rejected'], interview_count: 1 });
    expect(states(m)).toEqual(['done', 'skipped', 'skipped', 'failed', 'todo', 'todo']);
    expect(m.label).toBe('面试 · 未通过');
    expect(m.tone).toBe('neutral');
  });

  it('笔试后被拒：停在笔试；没有任何历史的被拒停在网申', () => {
    const m = applicationStepper({ stage: 'rejected', reached_stages: ['applied', 'rejected'], exam_kinds: ['written_test'] });
    expect(states(m)).toEqual(['done', 'skipped', 'failed', 'todo', 'todo', 'todo']);
    expect(m.label).toBe('笔试 · 未通过');
    expect(applicationStepper({ stage: 'rejected' }).label).toBe('网申 · 未通过');
  });

  it('放弃 / 跳过：投出前放弃停在网申，拿到 Offer 后放弃停在 Offer', () => {
    expect(states(applicationStepper({ stage: 'skip', reached_stages: ['evaluated', 'skip'] }))).toEqual(['failed', 'todo', 'todo', 'todo', 'todo', 'todo']);
    const m = applicationStepper({ stage: 'discarded', reached_stages: ['applied', 'interview', 'offer', 'discarded'] });
    expect(m.currentIndex).toBe(4);
    expect(m.label).toBe('Offer · 已放弃');
  });
});
