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
  useTabStateOptional: () => {
    useSyncExternalStore(
      (listener) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
      () => mocks.version,
    );
    return { ...mocks.tab };
  },
}));

import WaitingArcade, { HINT_AFTER_SECONDS } from './WaitingArcade';

function setBusy(busy: boolean) {
  mocks.tab.isLoading = busy;
  mocks.tab.sessionState = busy ? 'running' : 'idle';
  mocks.version += 1;
  act(() => { mocks.listeners.forEach(listener => listener()); });
}

describe('WaitingArcade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    mocks.config = {};
    setBusy(true);
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

  it('opens a focused game card and keeps game keys away from the chat', () => {
    mocks.tab.elapsed = HINT_AFTER_SECONDS;
    render(<WaitingArcade />);
    fireEvent.click(screen.getByRole('button', { name: '玩一把' }));

    const canvas = screen.getByTestId('waiting-arcade-canvas');
    expect(canvas).toHaveFocus();
    expect(screen.getByRole('tab', { name: '贪吃蛇' })).toHaveAttribute('aria-selected', 'true');

    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    fireEvent.keyDown(canvas, { code: 'ArrowUp', key: 'ArrowUp' });
    fireEvent.keyDown(canvas, { code: 'Space', key: ' ' });
    window.removeEventListener('keydown', windowKeys);
    expect(windowKeys).not.toHaveBeenCalled();
    expect(canvas).toHaveAttribute('data-phase', 'playing');

    fireEvent.blur(canvas);
    expect(canvas).toHaveAttribute('data-phase', 'paused');
  });

  it('pauses and tells the user when the reply lands', () => {
    mocks.tab.elapsed = HINT_AFTER_SECONDS;
    render(<WaitingArcade />);
    fireEvent.click(screen.getByRole('button', { name: '玩一把' }));
    const canvas = screen.getByTestId('waiting-arcade-canvas');
    fireEvent.keyDown(canvas, { code: 'ArrowUp', key: 'ArrowUp' });
    expect(canvas).toHaveAttribute('data-phase', 'playing');

    setBusy(false);
    expect(canvas).toHaveAttribute('data-phase', 'paused');
    expect(screen.getAllByText('AI 回复好了').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '回去看看' }));
    expect(screen.queryByTestId('waiting-arcade-card')).toBeNull();
  });

  it('switches games and closes with Escape', () => {
    mocks.tab.elapsed = HINT_AFTER_SECONDS;
    render(<WaitingArcade />);
    fireEvent.click(screen.getByRole('button', { name: '玩一把' }));
    fireEvent.click(screen.getByRole('tab', { name: '打砖块' }));
    expect(screen.getByTestId('waiting-arcade-canvas')).toHaveAccessibleName('打砖块');

    fireEvent.keyDown(screen.getByTestId('waiting-arcade-canvas'), { code: 'Escape', key: 'Escape' });
    expect(screen.queryByTestId('waiting-arcade-card')).toBeNull();
  });
});
