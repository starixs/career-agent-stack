import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';

import { PlaywrightBrowserHost } from './browser-host';
import type { BrowserContextRegistry } from './context-registry';
import { humanControlError } from './context-registry';

const TOKEN = 'c'.repeat(32);
const PORT = 31_416;
const AUTHORITY = `127.0.0.1:${PORT}`;

function fakeRegistry(control: 'agent' | 'human' = 'agent') {
  const context = { close: vi.fn(async () => {}), pages: vi.fn(() => []) } as unknown as BrowserContext;
  const registry = {
    runtimePolicy: { persistentProfile: true, systemChrome: true, mirrorIdentity: false, profileRoot: '/unused' },
    hasContext: vi.fn(() => true),
    getControl: vi.fn(() => ({ control, reason: null, since: 0 })),
    setControl: vi.fn(),
    assertAgentControl: vi.fn(() => { if (control === 'human') throw humanControlError(); }),
    retainConnection: vi.fn(),
    releaseConnection: vi.fn(),
    cancelPendingContext: vi.fn(),
    rekeyProductSession: vi.fn(() => true),
    reconcileTabAction: vi.fn(),
    getContext: vi.fn(async () => context),
    checkpoint: vi.fn(async () => {}),
    closeSessionContext: vi.fn(async () => {}),
    scheduleCheckpoint: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  return { registry, context };
}

function host(registry: ReturnType<typeof fakeRegistry>['registry'], verify = vi.fn(async () => ({
  productSessionId: 'session-a', workspacePath: '/workspace/a', hostGeneration: 1,
}))) {
  return new PlaywrightBrowserHost(PORT, {
    registry: registry as unknown as BrowserContextRegistry,
    verifyCapability: verify,
  });
}

describe('PlaywrightBrowserHost.withContext', () => {
  it('verifies, retains, runs, checkpoints and releases exactly once', async () => {
    const { registry, context } = fakeRegistry();
    const h = host(registry);
    const order: string[] = [];
    registry.retainConnection.mockImplementation(() => order.push('retain'));
    registry.releaseConnection.mockImplementation(() => order.push('release'));
    registry.scheduleCheckpoint.mockImplementation(() => order.push('checkpoint'));

    const result = await h.withContext(TOKEN, async (borrowed, binding) => {
      order.push('fn');
      expect(borrowed).toBe(context);
      expect(binding.productSessionId).toBe('session-a');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['retain', 'fn', 'checkpoint', 'release']);
    expect(registry.retainConnection).toHaveBeenCalledWith('session-a');
    expect(registry.releaseConnection).toHaveBeenCalledWith('session-a');
    expect(vi.mocked(context.close)).toHaveBeenCalledOnce();
    await h.shutdown();
  });

  it('releases the lease even when the callback throws', async () => {
    const { registry } = fakeRegistry();
    const h = host(registry);
    await expect(h.withContext(TOKEN, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(registry.retainConnection).toHaveBeenCalledOnce();
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    expect(registry.scheduleCheckpoint).toHaveBeenCalledOnce();
    await h.shutdown();
  });

  it('releases the lease when Context acquisition fails', async () => {
    const { registry } = fakeRegistry();
    registry.getContext.mockRejectedValueOnce(new Error('no browser'));
    const h = host(registry);
    await expect(h.withContext(TOKEN, async () => 1)).rejects.toThrow('no browser');
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    expect(registry.scheduleCheckpoint).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('rejects an invalid capability before touching the registry', async () => {
    const { registry } = fakeRegistry();
    const h = host(registry, vi.fn(async () => { throw new Error('nope'); }));
    await expect(h.withContext(TOKEN, async () => 1)).rejects.toMatchObject({ name: 'BROWSER_CAPABILITY_INVALID' });
    expect(registry.retainConnection).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('refuses agent work during human control unless explicitly allowed', async () => {
    const { registry } = fakeRegistry('human');
    const h = host(registry);
    const fn = vi.fn(async () => 'ran');
    await expect(h.withContext(TOKEN, fn)).rejects.toMatchObject({
      name: 'BROWSER_CONTROL_HUMAN',
      message: '用户正在接管浏览器，等待交回',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(registry.retainConnection).not.toHaveBeenCalled();

    await expect(h.withContext(TOKEN, fn, { allowHumanControl: true })).resolves.toBe('ran');
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    await h.shutdown();
  });

  it('answers browser_* tool calls with a tool error while the user holds the browser', async () => {
    const { registry } = fakeRegistry('human');
    const h = host(registry);
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: AUTHORITY,
    };
    const initialized = await h.handleRequest(new Request(`http://${AUTHORITY}/mcp/playwright`, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    }));
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id')!;

    const response = await h.handleRequest(new Request(`http://${AUTHORITY}/mcp/playwright`, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
      }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 2,
      result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('用户正在接管浏览器') }] },
    });
    expect(registry.getContext).not.toHaveBeenCalled();
    expect(registry.scheduleCheckpoint).not.toHaveBeenCalled();
    await h.shutdown();
  });
});
