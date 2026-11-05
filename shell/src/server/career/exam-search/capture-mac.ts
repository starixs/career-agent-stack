/**
 * macOS：调系统的 `screencapture -i`（用户框选，Esc 取消），截完用 `sips` 转 JPEG，长边超过上限才缩。
 * Retina 截图常有几 MB，缩完几百 KB，上传和模型都快。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CAPTURE_TIMEOUT_MS, MAX_IMAGE_SIDE, THUMB_SIDE, errorText, readCapture, type Capture, type RunFile } from './capture-common';

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

/** 在 dir 里框选截一张；按 Esc 取消时返回 null。 */
export async function captureMac(run: RunFile, dir: string): Promise<Capture | null> {
  const raw = join(dir, 'shot.png');
  const small = join(dir, 'shot.jpg');
  const thumb = join(dir, 'thumb.jpg');
  // 按 Esc 取消时有的系统版本退出码非 0：以有没有出文件为准，出错只记日志。
  const exit = await run('screencapture', ['-i', '-x', '-t', 'png', raw], { timeout: CAPTURE_TIMEOUT_MS })
    .then(() => null, errorText);
  const taken = await stat(raw).then(() => true, () => false);
  if (!taken) {
    console.log(`[exam-search] 这次没截（取消或超时）${exit ? `：${exit}` : ''}`);
    return null;
  }
  const side = await longSide(run, raw);
  await toJpeg(run, raw, small, side, MAX_IMAGE_SIDE);
  await toJpeg(run, raw, thumb, side, THUMB_SIDE);
  return readCapture(small, thumb);
}
