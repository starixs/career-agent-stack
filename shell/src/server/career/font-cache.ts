/**
 * 简历模板字体的本机缓存：resume-studio 的字体都是 CDN 地址（Google Fonts / jsDelivr）。
 *  - 渲染层的 CSP 不允许直接连 CDN，预览改走侧车 `/api/career/live/font?u=`；
 *  - 侧车导出直接用缓存文件路径（离线也能导出）；
 *  - 只代理字体清单里出现过的地址（白名单），文件按 URL 哈希落在 `$CAREER_DATA_DIR/fonts/`。
 * 中文字体单个字重约 10MB，下载一次后长期复用。
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

import { careerDataDir } from './db';

const inflight = new Map<string, Promise<string>>();
let allowed: Set<string> | null = null;

async function allowedUrls(): Promise<Set<string>> {
  if (!allowed) {
    const fonts = await import('@career/resume-studio/fonts');
    allowed = new Set(fonts.allWebFontUrls());
  }
  return allowed;
}

export function fontCacheDir(): string { return join(careerDataDir(), 'fonts'); }

/** 地址对应的缓存文件路径（不检查是否存在）。 */
export function cachedFontPath(url: string): string { return cachePath(url); }

function cachePath(url: string): string {
  const ext = (url.match(/\.(ttf|otf|woff2?)(?:$|\?)/i)?.[1] ?? 'ttf').toLowerCase();
  return join(fontCacheDir(), `${createHash('sha1').update(url).digest('hex')}.${ext}`);
}

export const FONT_MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

export class FontNotAllowedError extends Error {
  constructor() { super('不在简历字体清单里的地址'); this.name = 'FontNotAllowedError'; }
}

/** 返回缓存文件路径；没缓存就下载（同一地址并发只下载一次）。 */
export async function ensureFontCached(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!(await allowedUrls()).has(url)) throw new FontNotAllowedError();
  const path = cachePath(url);
  if (existsSync(path)) return path;
  const running = inflight.get(url);
  if (running) return running;
  const task = (async () => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`字体下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(fontCacheDir(), { recursive: true });
    const tmp = `${path}.part`;
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
    return path;
  })().finally(() => inflight.delete(url));
  inflight.set(url, task);
  return task;
}

export async function readCachedFont(url: string, fetchImpl?: typeof fetch): Promise<{ bytes: Buffer; mime: string }> {
  const path = await ensureFontCached(url, fetchImpl);
  const ext = path.split('.').pop() ?? 'ttf';
  return { bytes: readFileSync(path), mime: FONT_MIME[ext] ?? 'application/octet-stream' };
}

/** 测试用：重置白名单缓存。 */
export function resetFontAllowlist(urls?: string[]): void { allowed = urls ? new Set(urls) : null; }
