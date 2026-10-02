import { describe, expect, it } from 'vitest';

import { BROWSER_CONTROL_TRANSITIONS } from '@career/core';

import { RUN_TRANSITIONS, RunRegistry } from './runs';

function make() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const runs = new RunRegistry((event, data) => events.push({ event, data: data as Record<string, unknown> }), () => 'sess-9');
  return { runs, events };
}

describe('RunRegistry', () => {
  it('keeps RUN_TRANSITIONS in parity with @career/core (minus idle)', () => {
    for (const [from, tos] of Object.entries(RUN_TRANSITIONS)) {
      expect(tos).toEqual(BROWSER_CONTROL_TRANSITIONS[from as keyof typeof BROWSER_CONTROL_TRANSITIONS].filter(t => t !== 'idle'));
    }
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual(Object.keys(BROWSER_CONTROL_TRANSITIONS).filter(k => k !== 'idle').sort());
  });

  it('starts in running and broadcasts career:takeover with session id', () => {
    const { runs, events } = make();
    runs.start('run_1', { taskId: 'tsk_1', url: 'https://x' });
    expect(runs.get('run_1')?.state).toBe('running');
    expect(events).toEqual([{ event: 'career:takeover', data: { sessionId: 'sess-9', runId: 'run_1', state: 'running', url: 'https://x', taskId: 'tsk_1' } }]);
  });

  it('follows running → paused → human_active → resuming → running', () => {
    const { runs, events } = make();
    runs.start('r');
    runs.pause('r', 'captcha', { message: '需要验证码', handoffId: 'hnd_1' });
    expect(runs.get('r')).toMatchObject({ state: 'paused', reason: 'captcha', handoffId: 'hnd_1' });
    runs.transition('r', 'human_active');
    runs.transition('r', 'resuming');
    runs.transition('r', 'running', { handoffId: undefined });
    const rec = runs.get('r')!;
    expect(rec.state).toBe('running');
    expect(rec.reason).toBeUndefined();
    expect(rec.message).toBeUndefined();
    expect(events.map(e => e.data.state)).toEqual(['running', 'paused', 'human_active', 'resuming', 'running']);
  });

  it('rejects illegal transitions and unknown runs', () => {
    const { runs } = make();
    runs.start('r');
    expect(() => runs.transition('r', 'human_active')).toThrow(/不允许的接管流转/);
    expect(() => runs.transition('r', 'resuming')).toThrow(/不允许/);
    expect(() => runs.pause('nope', 'login')).toThrow(/run 不存在/);
  });

  it('finish removes the run without broadcasting', () => {
    const { runs, events } = make();
    runs.start('r');
    runs.finish('r');
    expect(runs.get('r')).toBeUndefined();
    expect(runs.list()).toEqual([]);
    expect(events).toHaveLength(1);
  });
});
