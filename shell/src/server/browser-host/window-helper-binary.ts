/**
 * macOS 原生窗口助手（native/career-window-helper.m）的可执行文件位置与启动。
 * 定位、开发机编译与 JSON 行协议是所有原生小助手共用的，见 utils/native-helper.ts。
 */
import { getScriptDir } from '../utils/runtime';
import { findPrebuiltHelper, resolveNativeHelper, type NativeHelperSpec } from '../utils/native-helper';

export { spawnHelper, type HelperEvent, type HelperProcess } from '../utils/native-helper';

export const WINDOW_HELPER_NAME = 'career-window-helper';

const WINDOW_HELPER: NativeHelperSpec = {
  name: WINDOW_HELPER_NAME,
  resourceDir: 'window-helper',
  source: new URL('./native/career-window-helper.m', import.meta.url),
  frameworks: ['AppKit', 'CoreGraphics'],
};

/** 预编译产物：发布包在 server-dist.js 旁；开发时向上找 src-tauri/resources。 */
export function findPrebuiltWindowHelper(scriptDir: string = getScriptDir()): string | null {
  return findPrebuiltHelper(WINDOW_HELPER, scriptDir);
}

/** 找到（必要时在开发机上编译）窗口助手；找不到就抛错，调用方退回无助手的行为。 */
export function resolveWindowHelper(devBinDir: string): Promise<string> {
  return resolveNativeHelper(WINDOW_HELPER, devBinDir);
}
