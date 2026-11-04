import { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import type { HelperEvent } from '../../utils/native-helper';

const mocks = vi.hoisted(() => ({ kv: new Map<string, unknown>(), emit: (_event: HelperEvent) => {} }));
vi.mock('../db', () => ({ careerDataDir: () => '/fixture/career', getRepos: async () => ({
  kvGet: (key: string) => mocks.kv.get(key), kvSet: (key: string, value: unknown) => mocks.kv.set(key, value),
}) }));
vi.mock('../../utils/native-helper', () => ({
  resolveNativeHelper: async () => '/fixture/helper',
  spawnHelper: (_bin: string, _args: string[], onEvent: (event: HelperEvent) => void) => {
    mocks.emit = onEvent;
    return { child: new ChildProcess(), send: vi.fn(), close: vi.fn() };
  },
}));

import { liveHub } from '../live-hub';
import { phoneLink } from './index';

afterEach(async () => { (await phoneLink()).unbind(); await (await phoneLink()).stop(); });

it('phone changes reach the Global live bridge without publishing SMS contents', async () => {
  const events: unknown[] = [];
  const unsubscribe = liveHub.subscribe(event => events.push(event));
  try {
    const service = await phoneLink();
    await service.bind('00-11-22-33-44-55', 'Fixture phone');
    mocks.emit({ ev: 'link', state: 'connected' });
    mocks.emit({ ev: 'sms', body: '验证码：123456', sender: 'fixture', time: '' });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) expect(event).toEqual({
      type: 'career:data-changed', sessionId: 'global', tables: ['phone_link'], ts: expect.any(Number),
    });
  } finally { unsubscribe(); }
});
