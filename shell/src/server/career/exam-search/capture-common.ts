/**
 * 框选截图的公共部分：结果格式、尺寸上限、命令执行器（测试注入）、读出成 base64。
 * macOS 见 capture-mac.ts，Windows 见 capture-windows.ts，入口在 capture.ts。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { LlmImage } from '@career/core';

/** 框选等人操作；比 Rust 代理的 120 秒上限短一点，超时就当这次没截。 */
export const CAPTURE_TIMEOUT_MS = 100_000;
/** 与粘贴截图一致：长边缩到这么多像素，题目文字依然清楚。 */
export const MAX_IMAGE_SIDE = 2000;
/** 小面板里的缩略图：托盘接口只回这个，原图留在侧车里，免得几 MB 的图来回走代理。 */
export const THUMB_SIDE = 240;

export interface Capture { image: LlmImage; thumb: string }

export interface RunOptions { timeout: number; windowsHide?: boolean }
export type RunFile = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;
export const runFile: RunFile = promisify(execFile);

/** 两份 JPEG（原图缩过的、缩略图）读成接口要的样子。 */
export async function readCapture(full: string, thumb: string): Promise<Capture> {
  const [image, preview] = await Promise.all([readFile(full), readFile(thumb)]);
  return { image: { mediaType: 'image/jpeg', data: image.toString('base64') }, thumb: `data:image/jpeg;base64,${preview.toString('base64')}` };
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
