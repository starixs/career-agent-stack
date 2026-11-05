import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { ShotTray, captureRegion, type RunFile } from './tray';

describe('宠物截图', () => {
  it('不是 macOS 直接说明，不去调截图命令', async () => {
    const calls: string[] = [];
    const run: RunFile = file => { calls.push(file); return Promise.resolve({ stdout: '' }); };
    await expect(captureRegion(run, 'win32')).rejects.toThrow('macOS');
    expect(calls).toEqual([]);
  });

  it('按 Esc 取消（没出文件）返回 null，不缩图', async () => {
    const calls: string[] = [];
    const run: RunFile = file => { calls.push(file); return Promise.reject(new Error('exit 1')); };
    expect(await captureRegion(run, 'darwin')).toBeNull();
    expect(calls).toEqual(['screencapture']);
  });

  it('截到了就转 JPEG 返回 base64：大图缩、小图不放大，另出一张缩略图', async () => {
    const sipsArgs: string[][] = [];
    const run: RunFile = async (file, args) => {
      if (file === 'screencapture') await writeFile(args[args.length - 1], 'png');
      if (file !== 'sips') return { stdout: '' };
      if (args[0] === '-g') return { stdout: '  pixelWidth: 900\n  pixelHeight: 300\n' };
      sipsArgs.push(args.slice(0, 2));
      await writeFile(args[args.length - 1], 'jpg');
      return { stdout: '' };
    };
    expect(await captureRegion(run, 'darwin')).toEqual({
      image: { mediaType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') },
      thumb: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`,
    });
    expect(sipsArgs).toEqual([['-s', 'format'], ['-Z', '240']]);
  });

  it('托盘按场分开，取走即清空', () => {
    const tray = new ShotTray();
    const shot = (data: string) => ({ image: { mediaType: 'image/jpeg' as const, data }, thumb: data });
    const a = tray.add('s1', shot('1'));
    tray.add('s2', shot('2'));
    expect(tray.remove('s1', a.id)).toBe(true);
    tray.add('s1', shot('3'));
    expect(tray.take('s1').map(s => s.image.data)).toEqual(['3']);
    expect(tray.list('s1')).toEqual([]);
    expect(tray.list('s2')).toHaveLength(1);
  });
});
