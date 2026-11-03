// 预编译 macOS 原生窗口助手（src/server/browser-host/native/career-window-helper.m）：
// 虚拟屏 + 托管 Chrome 焦点守卫 / 隐藏兜底。公共流程见 prepare-objc-helper.mjs。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareObjcHelper } from './prepare-objc-helper.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WINDOW_HELPER_SOURCE = join(ROOT, 'src', 'server', 'browser-host', 'native', 'career-window-helper.m');
export const WINDOW_HELPER_OUT_DIR = join(ROOT, 'src-tauri', 'resources', 'window-helper');
export const WINDOW_HELPER_BIN = join(WINDOW_HELPER_OUT_DIR, 'career-window-helper');

export function prepareWindowHelper(options) {
  return prepareObjcHelper({ name: 'career-window-helper', source: WINDOW_HELPER_SOURCE, outDir: WINDOW_HELPER_OUT_DIR, frameworks: ['AppKit', 'CoreGraphics'] }, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowHelper();
}
