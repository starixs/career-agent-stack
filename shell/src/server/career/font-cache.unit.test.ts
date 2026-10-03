import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureFontCached, readCachedFont, resetFontAllowlist } from './font-cache';

// 简历模板字体缓存：只代理字体清单里的地址；下载一次，之后从本机读；并发只下一次。

describe('font-cache', () => {
  let dir: string;
  const prev = process.env.CAREER_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'font-cache-')); process.env.CAREER_DATA_DIR = dir; resetFontAllowlist(['https://fonts.example/a.ttf']); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.CAREER_DATA_DIR; else process.env.CAREER_DATA_DIR = prev; resetFontAllowlist(); });

  it('白名单外的地址拒绝', async () => {
    await expect(ensureFontCached('https://evil.example/x.ttf', vi.fn() as never)).rejects.toThrow('不在简历字体清单');
  });

  it('首次下载落盘，之后直接读缓存；并发请求只下载一次', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const [a, b] = await Promise.all([ensureFontCached('https://fonts.example/a.ttf', fetchImpl as never), ensureFontCached('https://fonts.example/a.ttf', fetchImpl as never)]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const font = await readCachedFont('https://fonts.example/a.ttf', fetchImpl as never);
    expect(font).toMatchObject({ mime: 'font/ttf' });
    expect([...font.bytes]).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('下载失败报错且不留半截文件', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(ensureFontCached('https://fonts.example/a.ttf', fetchImpl as never)).rejects.toThrow('HTTP 503');
    const ok = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    await ensureFontCached('https://fonts.example/a.ttf', ok as never);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
