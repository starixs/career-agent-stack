import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import SimpleChatInput from './SimpleChatInput';
import { ToastProvider } from './Toast';

// 窗口不在前台时 rAF 不跑：建议条高度必须在 ResizeObserver 回调里同步上报，否则建议条盖住最后一条消息。

const workspaceService = vi.hoisted(() => ({
  isAvailable: true,
  importBase64Files: vi.fn(),
  copyPaths: vi.fn(),
  addGitignore: vi.fn(),
  prepareUserImageAttachments: vi.fn(),
  searchFiles: vi.fn(async () => []),
  listSlashCommands: vi.fn(async () => []),
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { chatSendShortcut: 'enter' } }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => workspaceService,
}));

const observers: CapturingResizeObserver[] = [];

class CapturingResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.length = 0;
});

function rect(height: number): DOMRect {
  return { height, width: 100, top: 0, left: 0, right: 100, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
}

describe('SimpleChatInput overlay height', () => {
  it('reports the real height synchronously even when requestAnimationFrame never runs', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
    let height = 40;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(height));
    const onOverlayHeightChange = vi.fn();
    render(
      <ToastProvider>
        <ImagePreviewProvider>
          <SimpleChatInput
            runtime="builtin"
            isLoading={false}
            onSend={vi.fn()}
            permissionMode="auto"
            onPermissionModeChange={vi.fn()}
            onOverlayHeightChange={onOverlayHeightChange}
          />
        </ImagePreviewProvider>
      </ToastProvider>,
    );
    expect(onOverlayHeightChange).toHaveBeenLastCalledWith(40);
    expect(observers.length).toBeGreaterThan(0);

    height = 132;
    observers.forEach((o) => o.fire());
    expect(onOverlayHeightChange).toHaveBeenLastCalledWith(132);

    const calls = onOverlayHeightChange.mock.calls.length;
    observers.forEach((o) => o.fire());
    expect(onOverlayHeightChange).toHaveBeenCalledTimes(calls);
  });
});
