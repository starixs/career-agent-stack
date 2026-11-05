/**
 * 宠物截图入口：按系统挑做法，临时文件放在一次性的目录里，用完就删（不留截图）。
 *   macOS → capture-mac.ts（screencapture -i + sips）
 *   Windows → capture-windows.ts（系统框选截图 ms-screenclip + 剪贴板 + System.Drawing）
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFile, type Capture, type RunFile } from './capture-common';
import { captureMac } from './capture-mac';
import { captureWindows } from './capture-windows';

/** 让用户框选截一张；取消时返回 null。 */
export async function captureRegion(run: RunFile = runFile, platform: NodeJS.Platform = process.platform): Promise<Capture | null> {
  const capture = platform === 'darwin' ? captureMac : platform === 'win32' ? captureWindows : null;
  if (!capture) throw new Error('宠物截图只支持 macOS 和 Windows；可以截图后在笔试助力页粘贴');
  const dir = await mkdtemp(join(tmpdir(), 'exam-shot-'));
  try {
    return await capture(run, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(err => console.warn(`[exam-search] 清理截图临时目录失败 ${dir}:`, err));
  }
}
