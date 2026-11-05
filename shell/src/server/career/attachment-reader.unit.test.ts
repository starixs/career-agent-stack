import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAttachmentContext,
  convertAttachment,
  docxXmlToText,
  drawingXmlToText,
  findAttachmentRefs,
  renderAttachmentContext,
  type ConvertDeps,
} from './attachment-reader';

/** 只有一行文字的最小 PDF（文字层很少，会被当作扫描件）。 */
const TINY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 100 Td (Zhang San Java) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'attach-'));
  mkdirSync(join(ws, 'keystone_files'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const failingOcr = vi.fn(async () => { throw new Error('当前系统没有内置 OCR'); });

describe('findAttachmentRefs', () => {
  it('只留工作区里存在、且需要转换的文件', () => {
    writeFileSync(join(ws, 'keystone_files', 'cv.pdf'), 'x');
    writeFileSync(join(ws, 'keystone_files', 'notes.md'), 'x');
    const refs = findAttachmentRefs('看看 @keystone_files/cv.pdf 和 @keystone_files/notes.md 还有 @keystone_files/missing.docx', ws);
    expect(refs).toEqual([join(ws, 'keystone_files', 'cv.pdf')]);
  });

  it('文件名带空格（输入框不加引号）也能认出来，加引号的也行', () => {
    writeFileSync(join(ws, 'keystone_files', '扫描 简历 v2.pdf'), 'x');
    writeFileSync(join(ws, 'keystone_files', 'a b.xlsx'), 'x');
    const refs = findAttachmentRefs('@keystone_files/扫描 简历 v2.pdf 帮我看看\n再看 @"keystone_files/a b.xlsx"', ws);
    expect(refs).toEqual([join(ws, 'keystone_files', '扫描 简历 v2.pdf'), join(ws, 'keystone_files', 'a b.xlsx')]);
  });

  it('邮箱之类的 @ 不算引用', () => {
    expect(findAttachmentRefs('发到 hr@example.com.pdf 吧', ws)).toEqual([]);
  });
});

describe('Office XML 抽文字', () => {
  it('Word：段落成行，表格按行列出', () => {
    const xml = '<w:body><w:p><w:r><w:t>张三</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">技能：</w:t><w:tab/><w:t>Java &amp; Go</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>公司</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>岗位</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>';
    expect(docxXmlToText(xml)).toBe('张三\n技能：\tJava & Go\n| 公司 | 岗位 |');
  });

  it('PPT：每个段落一行', () => {
    const xml = '<p:sp><a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:pPr/><a:r><a:t>要点 1</a:t></a:r><a:r><a:t>，补充</a:t></a:r></a:p></p:sp>';
    expect(drawingXmlToText(xml)).toBe('标题\n要点 1，补充');
  });
});

describe('convertAttachment 分层兜底', () => {
  it('表格走内置解析，并缓存', async () => {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['公司', '岗位'], ['腾讯', '后端']]), '投递');
    writeFileSync(join(ws, 'keystone_files', 'jobs.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const anydoc = vi.fn(async () => { throw new Error('DOCUMENT_RESOURCE_MISSING'); });
    const deps: ConvertDeps = { anydoc, ocr: failingOcr };

    const first = await convertAttachment(join(ws, 'keystone_files', 'jobs.xlsx'), ws, deps);
    expect(first.ok).toBe(true);
    expect(first.method).toBe('表格解析');
    expect(first.text).toContain('## 工作表：投递');
    expect(first.text).toContain('腾讯,后端');
    expect(first.attempts).toEqual(['AnyDoc：DOCUMENT_RESOURCE_MISSING']);

    const again = await convertAttachment(join(ws, 'keystone_files', 'jobs.xlsx'), ws, deps);
    expect(again.text).toBe(first.text);
    expect(again.method).toBe('表格解析');
    expect(anydoc).toHaveBeenCalledTimes(1);
  });

  it('AnyDoc 可用时优先用它', async () => {
    writeFileSync(join(ws, 'keystone_files', 'cv.docx'), 'not really a zip');
    const result = await convertAttachment(join(ws, 'keystone_files', 'cv.docx'), ws, {
      anydoc: async () => ({ text: '# 张三\n后端开发' }),
      ocr: failingOcr,
    });
    expect(result).toMatchObject({ ok: true, method: 'AnyDoc', text: '# 张三\n后端开发' });
  });

  it('扫描件：文字层太少就去 OCR', async () => {
    writeFileSync(join(ws, 'keystone_files', 'scan.pdf'), TINY_PDF);
    const result = await convertAttachment(join(ws, 'keystone_files', 'scan.pdf'), ws, {
      ocr: async () => ({ text: '张三 五年 Java 经验', pages: 1 }),
    });
    expect(result).toMatchObject({ ok: true, method: '系统 OCR', text: '张三 五年 Java 经验' });
    expect(result.attempts[0]).toContain('PDF 文本层');
  });

  it('OCR 也没有时，退回文字层读到的那一点', async () => {
    writeFileSync(join(ws, 'keystone_files', 'scan.pdf'), TINY_PDF);
    const result = await convertAttachment(join(ws, 'keystone_files', 'scan.pdf'), ws, { ocr: failingOcr });
    expect(result.ok).toBe(true);
    expect(result.method).toContain('文字很少');
    expect(result.text).toContain('Zhang San Java');
  });

  it('全部失败时如实记录每层原因', async () => {
    writeFileSync(join(ws, 'keystone_files', 'photo.png'), 'not an image');
    const result = await convertAttachment(join(ws, 'keystone_files', 'photo.png'), ws, {
      anydoc: async () => { throw new Error('management_unavailable'); },
      ocr: failingOcr,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toEqual(['AnyDoc：management_unavailable', '系统 OCR：当前系统没有内置 OCR']);
    const context = renderAttachmentContext([result])!;
    expect(context).toContain('status="unreadable"');
    expect(context).toContain('- 系统 OCR：当前系统没有内置 OCR');
  });
});

describe('buildAttachmentContext', () => {
  it('没有附件引用时不注入', async () => {
    expect(await buildAttachmentContext('帮我看看 @keystone_files/notes.md', ws, { ocr: failingOcr })).toBeNull();
  });

  it('长文档只内联前一段，告诉模型去哪里读全文', async () => {
    writeFileSync(join(ws, 'keystone_files', 'long.docx'), 'x');
    const context = await buildAttachmentContext('@keystone_files/long.docx', ws, {
      anydoc: async () => ({ text: '甲'.repeat(30_000) }),
      ocr: failingOcr,
    });
    expect(context).toContain('via="AnyDoc"');
    expect(context).toContain('后面还有约 22000 字');
    expect(context).toMatch(/用 Read 读 keystone_files\/\.converted\/long\.docx\.[0-9a-f]{10}\.md/);
  });
});

describe('图片附件：模型能看图时直接看原图（2026-11-04 DeepSeek V4 Flash 支持视觉）', () => {
  const img = { path: 'keystone_files/offer.png', name: 'offer.png', ok: true, text: '薪资 25k', method: '系统 OCR', attempts: [] as string[] };
  it('能看图：OCR 文字之外，让它用 Read 打开原图，图里的表格版式以原图为准', () => {
    const context = renderAttachmentContext([img], { vision: true })!;
    expect(context).toContain('薪资 25k');
    expect(context).toContain('用 Read 打开 keystone_files/offer.png 看原图');
  });
  it('能看图但 OCR 什么都没认出来：不说读不了，直接看原图', () => {
    const context = renderAttachmentContext([{ ...img, ok: false, text: '', attempts: ['系统 OCR：没有文字'] }], { vision: true })!;
    expect(context).not.toContain('没能转出文字');
    expect(context).toContain('用 Read 打开 keystone_files/offer.png 看原图');
  });
  it('不能看图：照旧只给 OCR 文字', () => {
    expect(renderAttachmentContext([img])!).not.toContain('看原图');
  });
});

describe('附件注入预算：Claude Code 把超过约 1 万字的钩子输出截成 2KB 预览，注入要留在阈值内', () => {
  const big = (name: string, ch: string) => ({
    path: name, name, ok: true, text: ch.repeat(20_000), method: 'AnyDoc', convertedPath: `.career/converted/${name}.md`, attempts: [],
  });

  it('两个 2 万字的附件，渲染结果总长低于 1 万字，并指向 text_path 读剩下的', () => {
    const context = renderAttachmentContext([big('a.pdf', '甲'), big('b.pdf', '乙')])!;
    expect(context.length).toBeLessThan(10_000);
    expect(context).toContain('Read 读 .career/converted/a.pdf.md');
    expect(context).toContain('Read 读 .career/converted/b.pdf.md');
  });

  it('前一份用掉大半预算后，放得下的短附件仍整份放入；放不下的只给路径和总字数', () => {
    const first = { ...big('a.pdf', '甲'), text: '甲'.repeat(7_900) };
    const short = { ...big('b.docx', '乙'), text: '乙'.repeat(50) };
    const context = renderAttachmentContext([first, short, big('c.pdf', '丙')])!;
    expect(context).toContain('乙'.repeat(50));
    expect(context).toContain('这份约 20000 字，这次没放进来；需要时用 Read 读 .career/converted/c.pdf.md');
    expect(context.length).toBeLessThan(10_000);
  });

  it('短附件原样全文注入', () => {
    const context = renderAttachmentContext([{ ...big('c.docx', '丙'), text: '一段简历正文' }])!;
    expect(context).toContain('一段简历正文');
    expect(context).not.toContain('没放进来');
  });
});
