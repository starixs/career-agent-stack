/**
 * 过机筛自检：按当前设置导出 PDF（开了过机筛就是 ATS 版），用 pdf.js 抽文字，交给 @career/resume 的 atsCheck 对照。
 * 回答"招聘系统能不能把这份简历读对"：文字能否读出、联系方式、分区标题、经历顺序、图标字体、照片、页数。
 */
import { readFileSync } from 'fs';
import type { AtsReport } from '@career/resume';

import { loadResume } from './domain';
import type { CareerStore } from './store';

export async function extractPdfText(pdf: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useWorkerFetch: false, disableFontFace: true, useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map(it => ('str' in it ? it.str : '')).join(' '));
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { text: parts.join('\n'), pages };
}

export async function runAtsCheck(deps: { store: CareerStore; exportPdf: (id: string) => Promise<string>; resolve: (schema: unknown) => unknown }, resumeId: string): Promise<AtsReport & { pdf_path: string }> {
  const found = deps.store.getResume(resumeId);
  if (!found) throw new Error(`简历不存在：${resumeId}`);
  const mod = await loadResume();
  const path = await deps.exportPdf(resumeId);
  const { text, pages } = await extractPdfText(readFileSync(path));
  const resume = mod.parseResume(deps.resolve(JSON.parse(found.row.schema_json)));
  return { ...mod.atsCheck(resume, text, pages), pdf_path: path };
}
