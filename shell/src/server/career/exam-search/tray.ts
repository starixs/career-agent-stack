/**
 * 宠物身上挂着的截图：开考后点一下宠物就框选截一张，先挂着，截够了一口气发出去。
 *
 *   capture：调系统的 `screencapture -i`（用户框选，Esc 取消），截完用 `sips` 缩到长边 2000 像素、转 JPEG，
 *            Retina 截图常有几 MB，缩完几百 KB，上传和模型都快；
 *   托盘只在内存里、按场分开：发出去就清空（记录里只存认出来的文字，不存图），侧车重启就没了。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { LlmImage } from '@career/core';

/** 一次最多发几张：再多模型认题变慢，也很少有一道题跨这么多屏。 */
export const MAX_SHOTS_PER_SEND = 6;
/** 框选等人操作；比 Rust 代理的 120 秒上限短一点，超时就当这次没截。 */
const CAPTURE_TIMEOUT_MS = 100_000;
/** 与粘贴截图一致：长边缩到这么多像素，题目文字依然清楚。 */
const MAX_IMAGE_SIDE = 2000;
/** 小面板里的缩略图：托盘接口只回这个，原图留在侧车里，免得几 MB 的图来回走代理。 */
const THUMB_SIDE = 240;

export interface Capture { image: LlmImage; thumb: string }
export interface TrayShot extends Capture { id: string; captured_at: string }
export interface TrayShotView { id: string; thumb: string; captured_at: string }

export type RunFile = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
const runFile: RunFile = promisify(execFile);

export class ShotTray {
  private readonly shots = new Map<string, TrayShot[]>();
  private seq = 0;

  list(sessionId: string): TrayShot[] {
    return this.shots.get(sessionId) ?? [];
  }

  /** 给界面看的：只带缩略图。 */
  view(sessionId: string): TrayShotView[] {
    return this.list(sessionId).map(({ id, thumb, captured_at }) => ({ id, thumb, captured_at }));
  }

  add(sessionId: string, capture: Capture): TrayShot {
    const shot = { id: `shot_${++this.seq}`, ...capture, captured_at: new Date().toISOString() };
    this.shots.set(sessionId, [...this.list(sessionId), shot]);
    return shot;
  }

  remove(sessionId: string, shotId: string): boolean {
    const before = this.list(sessionId);
    const after = before.filter(s => s.id !== shotId);
    this.shots.set(sessionId, after);
    return after.length < before.length;
  }

  /** 发送时整盘取走（取走即清空）。 */
  take(sessionId: string): TrayShot[] {
    const taken = this.list(sessionId);
    this.shots.delete(sessionId);
    return taken;
  }

  clear(): void {
    this.shots.clear();
  }
}

/** 整个侧车一份：宠物、小面板、主窗口看到的是同一个托盘。 */
export const examTray = new ShotTray();

/** 图的长边（像素）；读不出来按 0 算（那就不缩，只转格式）。 */
async function longSide(run: RunFile, file: string): Promise<number> {
  const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: CAPTURE_TIMEOUT_MS });
  const sides = [...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map(m => Number(m[1]));
  if (sides.length < 2) console.warn(`[exam-search] 读不出截图尺寸：${stdout.trim()}`);
  return Math.max(0, ...sides);
}

/** 转 JPEG；只缩不放（`sips -Z` 会把小图放大，框一道题常常只有几百像素）。 */
async function toJpeg(run: RunFile, from: string, to: string, side: number, max: number): Promise<void> {
  const resize = side > max ? ['-Z', String(max)] : [];
  await run('sips', [...resize, '-s', 'format', 'jpeg', from, '--out', to], { timeout: CAPTURE_TIMEOUT_MS });
}

/** 让用户框选截一张；按 Esc 取消时返回 null。只支持 macOS。 */
export async function captureRegion(run: RunFile = runFile, platform: NodeJS.Platform = process.platform): Promise<Capture | null> {
  if (platform !== 'darwin') throw new Error('宠物截图目前只支持 macOS；可以截图后在笔试助力页按 ⌘V');
  const dir = await mkdtemp(join(tmpdir(), 'exam-shot-'));
  const raw = join(dir, 'shot.png');
  const small = join(dir, 'shot.jpg');
  const thumb = join(dir, 'thumb.jpg');
  try {
    // 按 Esc 取消时有的系统版本退出码非 0：以有没有出文件为准，出错只记日志。
    const exit = await run('screencapture', ['-i', '-x', '-t', 'png', raw], { timeout: CAPTURE_TIMEOUT_MS })
      .then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    const taken = await stat(raw).then(() => true, () => false);
    if (!taken) {
      console.log(`[exam-search] 这次没截（取消或超时）${exit ? `：${exit}` : ''}`);
      return null;
    }
    const side = await longSide(run, raw);
    await toJpeg(run, raw, small, side, MAX_IMAGE_SIDE);
    await toJpeg(run, raw, thumb, side, THUMB_SIDE);
    const [full, preview] = await Promise.all([readFile(small), readFile(thumb)]);
    return { image: { mediaType: 'image/jpeg', data: full.toString('base64') }, thumb: `data:image/jpeg;base64,${preview.toString('base64')}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(err => console.warn(`[exam-search] 清理截图临时目录失败 ${dir}:`, err));
  }
}
