/**
 * 手机连接的进程级单例（只在 Global 侧车跑一份，与邮箱轮询同处启动，见 server/index.ts）。
 * 原生助手只有 macOS 版；其他平台 status().platform_supported = false，界面显示「暂只支持 Mac」。
 */
import { execFile } from 'child_process';
import { join } from 'path';

import { broadcast as sseBroadcast } from '../../sse';
import { resolveNativeHelper, spawnHelper, type NativeHelperSpec } from '../../utils/native-helper';
import { careerDataDir, getRepos } from '../db';
import { PhoneLinkService } from './link-service';
import { PHONE_TABLE } from '../../../shared/careerPhone';

export const PHONE_HELPER: NativeHelperSpec = {
  name: 'career-phone-helper',
  resourceDir: 'phone-helper',
  source: new URL('./native/career-phone-helper.m', import.meta.url),
  frameworks: ['Foundation', 'IOBluetooth'],
};

/** macOS 13+ 的蓝牙设置页；开着时这台电脑才能被手机搜到。 */
const BLUETOOTH_SETTINGS_URL = 'x-apple.systempreferences:com.apple.BluetoothSettings';
const OPEN_TIMEOUT_MS = 10_000;

let cachedName: Promise<string> | null = null;
/** 系统设置里的「电脑名称」，也是手机蓝牙列表里显示的名字。 */
function computerName(): Promise<string> {
  cachedName ??= new Promise<string>((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: OPEN_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  }).catch((error: unknown) => { cachedName = null; throw error; });
  return cachedName;
}

let service: PhoneLinkService | null = null;

async function createService(): Promise<PhoneLinkService> {
  const repos = await getRepos();
  const binDir = join(careerDataDir(), 'bin');
  return new PhoneLinkService({
    platformSupported: process.platform === 'darwin',
    kvGet: key => repos.kvGet(key),
    kvSet: (key, value) => repos.kvSet(key, value),
    spawn: async (args, onEvent, onExit) => {
      const bin = await resolveNativeHelper(PHONE_HELPER, binDir);
      const proc = spawnHelper(bin, args, onEvent);
      proc.child.on('exit', code => onExit(code));
      return proc;
    },
    openBluetoothSettings: () => new Promise((resolve, reject) => {
      execFile('/usr/bin/open', [BLUETOOTH_SETTINGS_URL], { timeout: OPEN_TIMEOUT_MS }, error => (error ? reject(error) : resolve()));
    }),
    changed: () => sseBroadcast('career:data-changed', { sessionId: 'global', tables: [PHONE_TABLE] }),
    computerName,
  });
}

let creating: Promise<PhoneLinkService> | null = null;

export function phoneLink(): Promise<PhoneLinkService> {
  if (service) return Promise.resolve(service);
  creating ??= createService().then((s) => { service = s; return s; }).finally(() => { creating = null; });
  return creating;
}

/** Global 侧车启动时调用：有绑定的手机就连上。失败只记日志，不影响侧车。 */
export function startCareerPhoneLink(): void {
  phoneLink().then(s => s.start()).catch((error: unknown) => console.warn('[phone-link] 启动失败:', error instanceof Error ? error.message : error));
}
