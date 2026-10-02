import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';

import type { VerifiedBrowserCapability } from './capability-client';
import {
  BrowserContextRegistry,
  HUMAN_CONTROL_MESSAGE,
  type BrowserContextRegistryDependencies,
} from './context-registry';
import type { BrowserIdentityState } from './identity-client';
import type { BrowserRuntimePolicy } from './runtime-settings';


function binding(session: string): VerifiedBrowserCapability {
  return { productSessionId: session, workspacePath: `/workspace/${session}`, hostGeneration: 3 };
}

function fakeContext(): BrowserContext & { emitter: EventEmitter } {
  const events = new EventEmitter();
  return Object.assign(events, {
    emitter: events,
    close: vi.fn(async () => { events.emit('close'); }),
    pages: vi.fn(() => [] as Page[]),
    newPage: vi.fn(),
    route: vi.fn(),
    unroute: vi.fn(),
    addCookies: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {}),
    cookies: vi.fn(async () => [{ name: 'sid', value: 'v', domain: 'example.test', path: '/' }]),
  }) as unknown as BrowserContext & { emitter: EventEmitter };
}

function harness(policy: Partial<BrowserRuntimePolicy>, overrides: Partial<BrowserContextRegistryDependencies> = {}) {
  const context = fakeContext();
  const browser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => context),
    once: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as Browser;
  const launch = vi.fn(async () => browser);
  const launchPersistentContext = vi.fn(async (_userDataDir: string, _options: Record<string, unknown>) => context);
  const checkpointIdentity = vi.fn(async (_s: string, _b: unknown, _o: unknown, state: BrowserIdentityState) => ({
    revision: 2, state, conflictCount: 0,
  }));
  const resolveResource = vi.fn(async () => ({ revision: 'r', executablePath: '/managed/chromium' }));
  const readIdentity = vi.fn(async () => ({
    revision: 1,
    state: { cookies: [{ name: 'seed', value: '1', domain: 'example.test', path: '/' }], origins: [] },
  }));
  const registry = new BrowserContextRegistry({
    readIdentity,
    checkpointIdentity,
    resolveResource,
    loadBrowserType: vi.fn(async () => ({ launch, launchPersistentContext } as unknown as BrowserType)),
    runtimePolicy: {
      persistentProfile: true,
      systemChrome: true,
      mirrorIdentity: false,
      profileRoot: '/unused',
      ...policy,
    },
    ...overrides,
  });
  return { registry, context, browser, launch, launchPersistentContext, checkpointIdentity, resolveResource, readIdentity };
}

describe('BrowserContextRegistry control lock', () => {
  it('defaults to agent control and rejects agent use while the user holds the browser', async () => {
    const { registry } = harness({ persistentProfile: false, systemChrome: false });
    expect(registry.getControl('a')).toMatchObject({ control: 'agent', reason: null });
    expect(() => registry.assertAgentControl('a')).not.toThrow();

    const state = registry.setControl('a', 'human', '  需要本人完成验证码 ');
    expect(state).toMatchObject({ control: 'human', reason: '需要本人完成验证码' });
    expect(registry.getControl('a')).toBe(state);
    expect(() => registry.assertAgentControl('a')).toThrowError(expect.objectContaining({
      name: 'BROWSER_CONTROL_HUMAN',
      message: HUMAN_CONTROL_MESSAGE,
    }));

    registry.setControl('a', 'agent');
    expect(registry.getControl('a').control).toBe('agent');
    await registry.shutdown();
  });

  it('inherits a takeover requested before the Context existed', async () => {
    const { registry } = harness({ persistentProfile: false, systemChrome: false });
    registry.setControl('a', 'human', 'login');
    await registry.getContext(binding('a'));
    expect(registry.hasContext('a')).toBe(true);
    expect(registry.getControl('a')).toMatchObject({ control: 'human', reason: 'login' });
    registry.setControl('a', 'agent');
    await registry.shutdown();
  });

  it('keeps the Context alive during human control instead of closing it after the idle grace', async () => {
    vi.useFakeTimers();
    try {
      const { registry, context } = harness({ persistentProfile: false, systemChrome: false });
      registry.retainConnection('a');
      await registry.getContext(binding('a'));
      registry.setControl('a', 'human', 'captcha');
      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(context.close).not.toHaveBeenCalled();

      registry.setControl('a', 'agent');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(context.close).toHaveBeenCalledOnce();
      expect(registry.hasContext('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns control to the agent when the user closes the browser', async () => {
    const { registry, context } = harness({ persistentProfile: false, systemChrome: false });
    await registry.getContext(binding('a'));
    registry.setControl('a', 'human');
    context.emitter.emit('close');
    await vi.waitFor(() => expect(registry.hasContext('a')).toBe(false));
    expect(registry.getControl('a')).toMatchObject({ control: 'agent', reason: '浏览器已关闭' });
    await registry.shutdown();
  });

  it('moves a takeover lease together with the adopted owner', async () => {
    const { registry } = harness({ persistentProfile: false, systemChrome: false });
    registry.retainConnection('pending-a');
    registry.setControl('pending-a', 'human', 'login');
    expect(registry.rekeyProductSession('pending-a', 'real-a')).toBe(true);
    expect(registry.getControl('real-a')).toMatchObject({ control: 'human', reason: 'login' });
    expect(registry.getControl('pending-a').control).toBe('agent');
    const owners = (registry as unknown as { connectionOwners: Map<string, { count: number }> }).connectionOwners;
    expect(owners.get('real-a')?.count).toBe(2);
    expect(owners.has('pending-a')).toBe(false);
    await registry.shutdown();
  });
});

describe('BrowserContextRegistry persistent profile', () => {
  let profileRoot: string;
  afterEach(() => { if (profileRoot) rmSync(profileRoot, { recursive: true, force: true }); });

  it('launches one persistent Chrome profile per Product Session and skips the managed resource', async () => {
    profileRoot = mkdtempSync(join(tmpdir(), 'keystone-browser-profile-'));
    const h = harness({ profileRoot });
    await registryContext(h.registry, 'session-a');

    expect(h.launchPersistentContext).toHaveBeenCalledOnce();
    const [userDataDir, options] = h.launchPersistentContext.mock.calls[0]!;
    expect(userDataDir).toBe(join(profileRoot, 'session-a'));
    expect(existsSync(userDataDir)).toBe(true);
    expect(options).toMatchObject({
      channel: 'chrome',
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    expect(options).not.toHaveProperty('executablePath');
    expect(h.resolveResource).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.context.addInitScript).toHaveBeenCalledWith(expect.stringContaining('webdriver'));
    // A brand-new profile is seeded once from the shared identity store.
    expect(h.context.addCookies).toHaveBeenCalledWith([expect.objectContaining({ name: 'seed' })]);
    await h.registry.shutdown();
  });

  it('does not reseed an existing profile and treats identity checkpoints as a no-op bypass', async () => {
    profileRoot = mkdtempSync(join(tmpdir(), 'keystone-browser-profile-'));
    const first = harness({ profileRoot, systemChrome: false });
    await registryContext(first.registry, 'session-a');
    await first.registry.shutdown();

    const second = harness({ profileRoot, systemChrome: false, mirrorIdentity: false }, {
      readIdentity: vi.fn(async () => { throw new Error('identity store offline'); }),
    });
    await registryContext(second.registry, 'session-a');
    expect(second.resolveResource).toHaveBeenCalledOnce();
    expect(second.launchPersistentContext.mock.calls[0]?.[1]).toMatchObject({ executablePath: '/managed/chromium' });
    expect(second.context.addCookies).not.toHaveBeenCalled();

    await second.registry.checkpoint('session-a');
    await second.registry.closeSessionContext('session-a');
    expect(second.checkpointIdentity).not.toHaveBeenCalled();
    expect(second.context.cookies).not.toHaveBeenCalled();
    expect(second.context.close).toHaveBeenCalledOnce();
  });

  it('mirrors cookies to the identity store only when asked and never fails the close on mirror errors', async () => {
    profileRoot = mkdtempSync(join(tmpdir(), 'keystone-browser-profile-'));
    const h = harness({ profileRoot, mirrorIdentity: true }, {
      checkpointIdentity: vi.fn(async () => { throw new Error('store offline'); }),
    });
    await registryContext(h.registry, 'session-a');
    await expect(h.registry.checkpoint('session-a')).resolves.toBeUndefined();
    expect(h.context.cookies).toHaveBeenCalled();
    await expect(h.registry.closeSessionContext('session-a')).resolves.toBeUndefined();
    expect(h.context.close).toHaveBeenCalledOnce();
  });
});

async function registryContext(registry: BrowserContextRegistry, session: string) {
  return registry.getContext(binding(session));
}
