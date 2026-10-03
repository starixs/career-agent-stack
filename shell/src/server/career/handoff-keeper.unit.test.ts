import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/admin-config', () => ({ loadConfig: () => ({}) }));

import { syncHandoffHold } from './batch-service';

// 接管守护：有等用户处理的接管且浏览器开着 → 持有浏览器（不被 15 秒空闲回收）；否则释放。

describe('syncHandoffHold', () => {
  const host = (hasContext: boolean) => ({ hasContext: vi.fn(() => hasContext), setHandoffHold: vi.fn() });

  it('有未关闭的接管且浏览器开着时持有', async () => {
    const h = host(true);
    expect(await syncHandoffHold({ repos: { openHandoffs: () => [{}] }, host: h, sessionId: 's' })).toBe(true);
    expect(h.setHandoffHold).toHaveBeenCalledWith('s', true);
  });

  it('接管都关了，或浏览器已经不在：释放', async () => {
    const h = host(true);
    expect(await syncHandoffHold({ repos: { openHandoffs: () => [] }, host: h, sessionId: 's' })).toBe(false);
    expect(h.setHandoffHold).toHaveBeenCalledWith('s', false);
    const gone = host(false);
    expect(await syncHandoffHold({ repos: { openHandoffs: () => [{}] }, host: gone, sessionId: 's' })).toBe(false);
    expect(gone.setHandoffHold).toHaveBeenCalledWith('s', false);
  });

  it('还没有会话或宿主：什么都不做', async () => {
    expect(await syncHandoffHold({ repos: { openHandoffs: () => [{}] }, host: null, sessionId: 's' })).toBe(false);
  });
});
