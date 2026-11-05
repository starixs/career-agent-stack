import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async () => {});
const stop = vi.fn(async () => {});

vi.mock('./connection-token', () => ({ productConnectionToken: () => 'token' }));
vi.mock('./extension-bridge', () => ({
  EXTENSION_BRIDGE_DEFAULT_PORT: 0,
  ExtensionBridge: { start: vi.fn(async () => ({ stop: vi.fn(async () => {}), isConnected: () => false })) },
}));
vi.mock('./product-browser', () => ({
  ProductBrowser: vi.fn(function ProductBrowser(this: Record<string, unknown>) {
    this.start = start;
    this.stop = stop;
    this.state = 'preparing';
  }),
}));

describe('product browser launches on first use, not at sidecar boot (11-05)', () => {
  beforeEach(() => {
    vi.resetModules();
    start.mockClear();
    vi.stubEnv('KEYSTONE_SIDECAR_ID', '__global__');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('starting the extension bridge does not launch Chrome', async () => {
    const host = await import('./bridge-host');
    expect(await host.ensureExtensionBridge()).not.toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(host.productBrowserWaitingMessage()).toBe('开始填表或打开网页时，浏览器会自动打开');
    await host.stopExtensionBridge();
  });

  it('the first ensureProductBrowserReady launches it', async () => {
    const host = await import('./bridge-host');
    await host.ensureExtensionBridge();
    await host.ensureProductBrowserReady();
    expect(start).toHaveBeenCalledTimes(1);
    expect(host.productBrowserWaitingMessage()).not.toBe('开始填表或打开网页时，浏览器会自动打开');
    await host.stopExtensionBridge();
  });
});
