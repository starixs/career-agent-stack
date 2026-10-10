import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  version: 0,
  config: {} as { waitingArcadeEnabled?: boolean },
  tab: {
    isLoading: true,
    sessionState: 'running',
    elapsed: 0,
    getQueryElapsedSeconds: () => mocks.tab.elapsed,
    pendingPermission: null as unknown,
    pendingAskUserQuestion: null as unknown,
    pendingExitPlanMode: null as unknown,
  },
}));

vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: mocks.config }) }));
// 与真实 TabContext 一样：状态变化会让订阅组件重渲染（WaitingArcade 是 memo 组件）
vi.mock('@/context/TabContext', () => ({
  useTabActive: () => true,
  useTabStateOptional: () => {
    useSyncExternalStore(
      (listener) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
      () => mocks.version,
    );
    return { ...mocks.tab };
  },
}));

import WaitingArcade, { HINT_AFTER_SECONDS } from './WaitingArcade';

function setTab(patch: Partial<typeof mocks.tab>) {
  Object.assign(mocks.tab, patch);
  mocks.version += 1;
  act(() => { mocks.listeners.forEach(listener => listener()); });
}

function setBusy(busy: boolean) {
  setTab({ isLoading: busy, sessionState: busy ? 'running' : 'idle' });
}

function pullOut() {
  mocks.tab.elapsed = HINT_AFTER_SECONDS;
  render(<WaitingArcade />);
  fireEvent.click(screen.getByRole('button', { name: '玩一把' }));
  return screen.getByTestId('waiting-arcade-handheld');
}

describe('WaitingArcade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    mocks.config = {};
    mocks.tab.isLoading = true;
    mocks.tab.sessionState = 'running';
    mocks.tab.elapsed = 0;
    mocks.tab.pendingPermission = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('offers a game only after the turn has run for a while', () => {
    render(<WaitingArcade />);
    expect(screen.queryByTestId('waiting-arcade-hint')).toBeNull();
    mocks.tab.elapsed = HINT_AFTER_SECONDS;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('waiting-arcade-hint')).toHaveTextContent('来一把');
  });

  it('stays quiet while the AI is waiting on the user', () => {
    mocks.tab.elapsed = HINT_AFTER_SECONDS + 5;
    mocks.tab.pendingPermission = { requestId: 'p1' };
    render(<WaitingArcade />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByTestId('waiting-arcade-hint')).toBeNull();
  });

  it('respects the settings switch', () => {
    mocks.config = { waitingArcadeEnabled: false };
    mocks.tab.elapsed = HINT_AFTER_SECONDS + 5;
    render(<WaitingArcade />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByTestId('waiting-arcade-hint')).toBeNull();
  });

  it('dismissal lasts for the current turn only', () => {
    mocks.tab.elapsed = HINT_AFTER_SECONDS;
    render(<WaitingArcade />);
    fireEvent.click(screen.getByRole('button', { name: '这次不玩' }));
    expect(screen.queryByTestId('waiting-arcade-hint')).toBeNull();

    setBusy(false);
    setBusy(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('waiting-arcade-hint')).toBeInTheDocument();
  });

  it('pulls out a focused handheld that boots into the game menu', () => {
    const device = pullOut();
    expect(device).toHaveFocus();
    expect(device).toHaveAttribute('data-mode', 'boot');
    fireEvent.keyDown(device, { code: 'Enter', key: 'Enter' });
    expect(device).toHaveAttribute('data-mode', 'menu');
  });

  it('presses the physical button for each key and keeps game keys away from the chat', () => {
    const device = pullOut();
    const a = device.querySelector('.hh-a')!;
    const up = device.querySelector('.hh-dpad-up')!;
    const dpad = device.querySelector('.hh-dpad') as HTMLElement;

    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    fireEvent.keyDown(device, { code: 'KeyX', key: 'x' });
    fireEvent.keyDown(device, { code: 'ArrowUp', key: 'ArrowUp' });
    window.removeEventListener('keydown', windowKeys);
    expect(windowKeys).not.toHaveBeenCalled();

    expect(a).toHaveAttribute('data-pressed', 'true');
    expect(up).toHaveAttribute('data-pressed', 'true');
    expect(dpad).toHaveAttribute('data-dir', 'up');
    expect(dpad.style.transform).toContain('rotateX(12deg)');

    fireEvent.keyUp(device, { code: 'KeyX', key: 'x' });
    fireEvent.keyUp(device, { code: 'ArrowUp', key: 'ArrowUp' });
    expect(a).not.toHaveAttribute('data-pressed');
    expect(dpad.style.transform).toBe('none');
  });

  it('lets shortcut chords pass through untouched', () => {
    const device = pullOut();
    const event = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', metaKey: true, bubbles: true, cancelable: true });
    device.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(device.querySelector('.hh-dpad-up')).not.toHaveAttribute('data-pressed');
  });

  it('works with the mouse on the shell buttons too', () => {
    const device = pullOut();
    const start = device.querySelector('.hh-start .hh-meta-btn')!;
    fireEvent.pointerDown(start, { pointerId: 1 });
    expect(start).toHaveAttribute('data-pressed', 'true');
    expect(device).toHaveAttribute('data-mode', 'menu');
    fireEvent.pointerUp(start, { pointerId: 1 });
    expect(start).not.toHaveAttribute('data-pressed');
  });

  it('pauses mid-game when the reply lands and sends the user back', () => {
    const device = pullOut();
    fireEvent.keyDown(device, { code: 'Enter', key: 'Enter' }); // 跳过开机
    fireEvent.keyUp(device, { code: 'Enter', key: 'Enter' });
    fireEvent.keyDown(device, { code: 'Enter', key: 'Enter' }); // 开始游戏
    fireEvent.keyUp(device, { code: 'Enter', key: 'Enter' });
    expect(device).toHaveAttribute('data-mode', 'playing');

    setBusy(false);
    expect(device).toHaveAttribute('data-mode', 'paused');
    expect(screen.getByRole('status')).toHaveTextContent('AI 回复好了');
    expect(device.querySelector('.hh-led')).toHaveAttribute('data-alert', 'true');

    fireEvent.click(screen.getByRole('button', { name: '回去看看' }));
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByTestId('waiting-arcade-handheld')).toBeNull();
  });

  it('puts the handheld away with Escape after the slide-down', () => {
    const device = pullOut();
    fireEvent.keyDown(device, { code: 'Escape', key: 'Escape' });
    expect(device.closest('.hh-stage')).toHaveAttribute('data-stage', 'closing');
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByTestId('waiting-arcade-handheld')).toBeNull();
    // 收起即算本轮不玩：提示不会马上又冒出来
    expect(screen.queryByTestId('waiting-arcade-hint')).toBeNull();
  });

  it('pauses when focus leaves the handheld', () => {
    const device = pullOut();
    fireEvent.keyDown(device, { code: 'KeyX', key: 'x' });
    fireEvent.keyUp(device, { code: 'KeyX', key: 'x' });
    fireEvent.keyDown(device, { code: 'KeyX', key: 'x' });
    expect(device).toHaveAttribute('data-mode', 'playing');
    fireEvent.blur(device);
    expect(device).toHaveAttribute('data-mode', 'paused');
    expect(device.querySelector('.hh-a')).not.toHaveAttribute('data-pressed');
  });
});
