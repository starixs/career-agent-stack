import { describe, expect, it } from 'vitest';

import { ScreencastHub, type CdpSessionLike, type ScreencastPageLike } from './screencast';

// 直播帧：首个订阅者启动 screencast，帧回 ack 并广播，最后一个订阅者离开就停。

function fakePage() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let listener: ((ev: { data: string; sessionId: number; metadata: Record<string, number> }) => void) | null = null;
  let detached = 0;
  const session: CdpSessionLike = {
    send: async (method, params) => { sent.push({ method, params }); return {}; },
    on: (_event, fn) => { listener = fn as typeof listener; },
    detach: async () => { detached++; },
  };
  const page: ScreencastPageLike = { url: () => 'https://x.com/apply', title: async () => '网申', isClosed: () => false, newCDPSession: async () => session };
  return { page, sent, emit: (data: string) => listener?.({ data, sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 900 } }), detached: () => detached };
}

describe('ScreencastHub', () => {
  it('订阅 → 启动 screencast → 帧广播 + ack → 退订 → 停止并 detach', async () => {
    const { page, sent, emit, detached } = fakePage();
    const hub = new ScreencastHub(async () => page, { quality: 40 });
    const frames: string[] = [];
    const unsub = hub.subscribe(f => frames.push(f.data));
    await new Promise(r => setTimeout(r, 5));
    expect(sent.map(s => s.method).slice(0, 2)).toEqual(['Page.enable', 'Page.startScreencast']); // 不 enable 收不到帧
    expect(sent.find(s => s.method === 'Page.startScreencast')).toMatchObject({ params: { format: 'jpeg', quality: 40 } });
    emit('AAA'); emit('BBB');
    expect(frames).toEqual(['AAA', 'BBB']);
    expect(sent.filter(s => s.method === 'Page.screencastFrameAck').map(s => s.params?.sessionId)).toEqual([7, 7]);
    expect(hub.lastFrame()?.width).toBe(1280);
    // 第二个订阅者立刻拿到最近一帧，不重复启动
    const late: string[] = [];
    const unsub2 = hub.subscribe(f => late.push(f.data));
    expect(late).toEqual(['BBB']);
    expect(sent.filter(s => s.method === 'Page.startScreencast')).toHaveLength(1);
    unsub(); unsub2();
    await new Promise(r => setTimeout(r, 5));
    expect(sent.some(s => s.method === 'Page.stopScreencast')).toBe(true);
    expect(detached()).toBe(1);
  });
  it('refresh：同一页面的新包装（借用代理每次都是新对象）不重启；真的换页才重启', async () => {
    const { page, sent } = fakePage();
    const frameA = {}; const frameB = {};
    let current = frameA;
    // 模拟 fromPlaywrightPage：每次 getPage 都是新包装，身份来自 mainFrame
    const hub = new ScreencastHub(async () => { const frame = current; return { ...page, identity: () => frame }; });
    const unsub = hub.subscribe(() => {});
    await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 3; i++) await hub.refresh();
    expect(sent.filter(s => s.method === 'Page.startScreencast')).toHaveLength(1);
    expect(sent.some(s => s.method === 'Page.stopScreencast')).toBe(false);
    current = frameB;
    await hub.refresh();
    expect(sent.filter(s => s.method === 'Page.startScreencast')).toHaveLength(2);
    unsub();
  });
  it('没有页面时启动失败不影响订阅者，stop 幂等', async () => {
    const hub = new ScreencastHub(async () => null);
    const unsub = hub.subscribe(() => {});
    await new Promise(r => setTimeout(r, 5));
    expect(hub.subscriberCount).toBe(1);
    unsub();
    await hub.stop(); await hub.stop();
    expect(hub.subscriberCount).toBe(0);
  });
});
