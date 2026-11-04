import { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { PhoneLinkService } from '../career/phone/link-service';
import { PHONE_KV_KEY } from '../../shared/careerPhone';
import { phoneRoutes } from './career-phone';

it('explicit reconnect keeps memory and never starts first-time pairing', async () => {
  const remembered = { address: '00-11-22-33-44-55', name: 'Fixture phone', bound_at: '2026-01-01T00:00:00Z', last_connected_at: '2026-01-02T00:00:00Z' };
  const kv = new Map<string, unknown>([[PHONE_KV_KEY, remembered]]);
  const settings = vi.fn(async () => {});
  const spawn = vi.fn(async (_args: string[]) => ({ child: new ChildProcess(), send: vi.fn(), close: vi.fn() }));
  const service = new PhoneLinkService({ platformSupported: true, kvGet: k => kv.get(k), kvSet: (k, v) => { kv.set(k, v); },
    spawn, openBluetoothSettings: settings, changed: vi.fn(),
  });
  const route = phoneRoutes(async () => service).find(([method, path]) => method === 'POST' && path.endsWith('/reconnect'));
  if (!route) throw new Error('Missing reconnect route');
  try {
    expect((await route[2]({ body: {} })).status).toBe(200);
    expect(kv.get(PHONE_KV_KEY)).toEqual(remembered);
    expect(spawn.mock.calls[0]?.[0]).toEqual(['link', remembered.address]);
    expect(settings).not.toHaveBeenCalled();
    service.unbind();
    expect((await route[2]({ body: {} })).status).toBe(409);
  } finally { await service.stop(); }
});
