import { describe, expect, it } from 'vitest';

import { AppleVisionOcrPerceiver } from './apple-vision-ocr';
import { joinCjkSpacing, parseWindowsOcrOutput, WINDOWS_OCR_PS } from './windows-ocr';

// Windows OCR：脚本在 Windows 上跑，这里测输出解析与和 macOS 版共用的坐标换算。

describe('Windows OCR', () => {
  it('中文字之间的空格去掉，英文单词之间保留', () => {
    expect(joinCjkSpacing('真 实 姓 名 ：')).toBe('真实姓名：');
    expect(joinCjkSpacing('Email 地 址')).toBe('Email 地址');
    expect(joinCjkSpacing('First Name')).toBe('First Name');
  });

  it('解析：单行时 ConvertTo-Json 输出的是对象也能认；报错透传', () => {
    const one = parseWindowsOcrOutput('{"width":1000,"height":500,"lines":{"text":"手 机 号","confidence":0.9,"x":0.1,"y":0.2,"w":0.1,"h":0.05}}\r\n');
    expect(one.lines).toEqual([{ text: '手机号', confidence: 0.9, x: 0.1, y: 0.2, w: 0.1, h: 0.05 }]);
    expect(parseWindowsOcrOutput('{"width":10,"height":10}').lines).toEqual([]);
    expect(parseWindowsOcrOutput('{"error":"no OCR language pack installed"}')).toEqual({ error: 'no OCR language pack installed' });
  });

  it('输出喂给同一套坐标换算，得到视口坐标的文字元素', async () => {
    const payload = parseWindowsOcrOutput('{"width":2732,"height":1536,"lines":[{"text":"姓 名","confidence":0.9,"x":0.1,"y":0.2,"w":0.05,"h":0.02}]}');
    const ocr = new AppleVisionOcrPerceiver({ runImpl: async () => payload });
    const p = await ocr.perceive(new Uint8Array([1, 2, 3]), { viewport: { width: 1366, height: 768 } });
    expect(p.elements).toEqual([expect.objectContaining({ kind: 'text', text: '姓名', box: { x: 137, y: 154, w: 68, h: 15 } })]);
  });

  it('脚本里没有被模板插值吃掉的东西（$_ 等原样保留，反引号转义正确）', () => {
    expect(WINDOWS_OCR_PS).toContain("ParameterType.Name -eq 'IAsyncOperation`1'");
    expect(WINDOWS_OCR_PS).toContain('$_.Name -eq \'AsTask\'');
    expect(WINDOWS_OCR_PS).toContain("[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)");
  });
});
