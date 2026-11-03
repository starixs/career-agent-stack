// 预编译 macOS 手机连接助手（src/server/career/phone/native/career-phone-helper.m）：
// 蓝牙短信读取（MAP）收验证码，手机上不装 App。公共流程见 prepare-objc-helper.mjs。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareObjcHelper } from './prepare-objc-helper.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PHONE_HELPER_SOURCE = join(ROOT, 'src', 'server', 'career', 'phone', 'native', 'career-phone-helper.m');
export const PHONE_HELPER_OUT_DIR = join(ROOT, 'src-tauri', 'resources', 'phone-helper');
export const PHONE_HELPER_BIN = join(PHONE_HELPER_OUT_DIR, 'career-phone-helper');

export function preparePhoneHelper(options) {
  return prepareObjcHelper({ name: 'career-phone-helper', source: PHONE_HELPER_SOURCE, outDir: PHONE_HELPER_OUT_DIR, frameworks: ['Foundation', 'IOBluetooth'] }, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePhoneHelper();
}
