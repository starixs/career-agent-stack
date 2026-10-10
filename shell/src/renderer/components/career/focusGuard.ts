/**
 * 焦点守卫：托管 Chrome 开新页时 macOS 会激活它，产品窗口的焦点被抢走（用户正在打字也会被打断）。
 * Global 广播 `career:browser-window` 后，只有"产品窗口刚刚才失焦"——说明是被 Chrome 抢走的——才把焦点拿回来；
 * 用户本来就在别的 App 里，不去打扰。渲染层自己的窗口 setFocus 不受跨进程激活限制。
 */
export const STOLEN_FOCUS_WINDOW_MS = 4000;

export interface FocusTrack { focused: boolean; lastBlurAt: number; focusedBeforeBlur: boolean }

/** 纯函数：此刻要不要把焦点拿回来。 */
export function shouldReturnFocus(track: FocusTrack, now: number): boolean {
  if (track.focused) return false;
  if (!track.focusedBeforeBlur) return false;
  return now - track.lastBlurAt <= STOLEN_FOCUS_WINDOW_MS;
}

const track: FocusTrack = { focused: typeof document !== 'undefined' ? document.hasFocus() : true, lastBlurAt: 0, focusedBeforeBlur: false };
let installed = false;

/** 记录窗口的得失焦（App 根上装一次）。 */
export function installFocusTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('blur', () => { track.focusedBeforeBlur = track.focused; track.focused = false; track.lastBlurAt = Date.now(); });
  window.addEventListener('focus', () => { track.focused = true; });
}

/** 收到托管窗口事件时调用。 */
export async function returnFocusIfStolen(now = Date.now()): Promise<boolean> {
  if (!shouldReturnFocus(track, now)) return false;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFocus();
    return true;
  } catch {
    return false; // 浏览器模式 / 非 Tauri 环境
  }
}
