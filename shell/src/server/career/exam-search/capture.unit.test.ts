import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { captureRegion } from './capture';
import type { RunFile } from './capture-common';
import { EXIT_CANCELLED, EXIT_TOOL_FAILED, windowsCaptureScript } from './capture-windows';
import { ShotTray } from './tray';

describe('宠物截图', () => {
  it('macOS、Windows 以外直接说明，不去调截图命令', async () => {
    const calls: string[] = [];
    const run: RunFile = file => { calls.push(file); return Promise.resolve({ stdout: '' }); };
    await expect(captureRegion(run, 'linux')).rejects.toThrow('macOS 和 Windows');
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

  describe('Windows', () => {
    const exitWith = (code: number) => Object.assign(new Error(`Command failed: exit ${code}`), { code });
    const decode = (args: string[]) => Buffer.from(args[args.length - 1], 'base64').toString('utf16le');

    it('截到了：一段 PowerShell（-STA、隐藏窗口）开系统框选，读两份 JPEG', async () => {
      const seen: Array<{ file: string; args: string[]; hide?: boolean }> = [];
      const run: RunFile = async (file, args, options) => {
        seen.push({ file, args, hide: options.windowsHide });
        const script = decode(args);
        for (const m of script.matchAll(/Save-Jpeg \$img \d+ '([^']+)'/g)) await writeFile(m[1], 'jpg');
        return { stdout: '' };
      };
      const shot = await captureRegion(run, 'win32');
      expect(shot?.image).toEqual({ mediaType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ file: 'powershell.exe', hide: true });
      expect(seen[0].args).toContain('-STA');
      expect(decode(seen[0].args)).toContain("Start-Process 'ms-screenclip:'");
    });

    it('取消或超时返回 null；截图工具打不开报错并提示 Win+Shift+S', async () => {
      expect(await captureRegion(() => Promise.reject(exitWith(EXIT_CANCELLED)), 'win32')).toBeNull();
      await expect(captureRegion(() => Promise.reject(exitWith(EXIT_TOOL_FAILED)), 'win32')).rejects.toThrow('Win+Shift+S');
    });

    it('路径里的单引号在 PowerShell 字面量里成对转义，只缩不放', () => {
      const script = windowsCaptureScript("C:\\Users\\O'Neil\\shot.jpg", 'C:\\t.jpg');
      expect(script).toContain("'C:\\Users\\O''Neil\\shot.jpg'");
      expect(script).toContain('[Math]::Min(1.0,');
    });
  });
});
