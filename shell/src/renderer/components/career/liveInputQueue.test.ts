import { describe, expect, it } from 'vitest';

import { createLiveInputQueue, type LiveInput } from './liveInputQueue';

/** 一个手动放行的 send：每次调用挂起，release() 放行最早那一个。 */
function gatedSend() {
  const sent: LiveInput[] = [];
  const gates: Array<() => void> = [];
  const send = (input: LiveInput) => new Promise<void>(resolve => { sent.push(input); gates.push(resolve); });
  const release = async () => { gates.shift()?.(); await new Promise(r => setTimeout(r, 0)); };
  return { sent, send, release };
}

describe('现场窗操作队列（2026-11-05 现场窗交互卡顿）', () => {
  it('一次只发一个，按发生顺序；等着的时候连打的字合成一次写入', async () => {
    const g = gatedSend();
    const enqueue = createLiveInputQueue(g.send);
    void enqueue({ type: 'click', x: 1, y: 1 });
    for (const ch of '周子航') void enqueue({ type: 'type', text: ch });
    void enqueue({ type: 'press', key: 'Enter' });
    expect(g.sent.map(i => i.type)).toEqual(['click']);
    await g.release();
    expect(g.sent.at(-1)).toEqual({ type: 'type', text: '周子航' });
    await g.release();
    expect(g.sent.at(-1)).toEqual({ type: 'press', key: 'Enter' });
  });

  it('滚轮在等的时候把位移累加，轮到时一次滚到位；拖动只留最新位置', async () => {
    const g = gatedSend();
    const enqueue = createLiveInputQueue(g.send);
    void enqueue({ type: 'down', x: 0, y: 0 });
    for (let i = 0; i < 30; i++) void enqueue({ type: 'wheel', dx: 0, dy: 10 });
    void enqueue({ type: 'move', x: 5, y: 5 });
    void enqueue({ type: 'move', x: 9, y: 9 });
    await g.release();
    expect(g.sent.at(-1)).toMatchObject({ type: 'wheel', dy: 300 });
    await g.release();
    expect(g.sent.at(-1)).toMatchObject({ type: 'move', x: 9, y: 9 });
    expect(g.sent).toHaveLength(3);
  });

  it('一个发失败不卡住后面的', async () => {
    const sent: string[] = [];
    const enqueue = createLiveInputQueue(async input => { sent.push(input.type); if (input.type === 'click') throw new Error('页面关了'); });
    await Promise.all([enqueue({ type: 'click' }), enqueue({ type: 'press', key: 'Tab' })]);
    expect(sent).toEqual(['click', 'press']);
  });
});
