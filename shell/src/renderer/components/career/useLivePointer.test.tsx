import { act, renderHook } from '@testing-library/react';
import type { MouseEvent } from 'react';
import { describe, expect, it } from 'vitest';

import { useLivePointer, type LivePointerInput } from './useLivePointer';

const ev = (x: number, y: number, extra: Partial<{ button: number; detail: number }> = {}) => ({ clientX: x, clientY: y, button: 0, detail: 1, ...extra }) as unknown as MouseEvent<HTMLElement>;

describe('现场画面拖动实时转发', () => {
  it('按下立刻发；移动只发最新位置、不积压；松开最后到；按下 + 松开带出的 click 被吞掉', async () => {
    const sent: LivePointerInput[] = [];
    let release: () => void = () => undefined;
    // 第一个请求（按下）慢：期间来的几次移动只应留下最新一个
    const send = (input: LivePointerInput) => new Promise<void>(resolve => { sent.push(input); if (input.type === 'down') release = resolve; else resolve(); });
    const { result } = renderHook(() => useLivePointer(send, e => ({ x: e.clientX, y: e.clientY }), () => ({ width: 100, height: 100 })));
    act(() => { result.current.onMouseDown(ev(1, 1)); });
    act(() => { result.current.onMouseMove(ev(5, 1)); result.current.onMouseMove(ev(9, 1)); result.current.onMouseMove(ev(30, 2)); });
    act(() => { result.current.onMouseUp(ev(31, 2)); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); }); // 发送链在下一个微任务才发出「按下」
    expect(sent.map(s => s.type)).toEqual(['down']); // 按下还在路上：移动不抢跑、不积压
    await act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
    expect(sent.map(s => `${s.type}:${s.x}`)).toEqual(['down:1', 'move:30', 'up:31']);
    expect(result.current.consumeClick()).toBe(true);
    expect(result.current.consumeClick()).toBe(false);
  });

  it('没按着时移动不发；右键不算拖动', () => {
    const sent: LivePointerInput[] = [];
    const { result } = renderHook(() => useLivePointer(async i => { sent.push(i); }, e => ({ x: e.clientX, y: e.clientY }), () => ({ width: 100, height: 100 })));
    act(() => { result.current.onMouseMove(ev(5, 5)); result.current.onMouseDown(ev(5, 5, { button: 2 })); });
    expect(sent).toEqual([]);
  });
});
