/**
 * 简历导出：schema_json → @career/resume 渲染 → 写到 `CAREER_DATA_DIR/exports/<id>.<ext>`。
 * 路由与工具共用；领域库未就绪时抛 DomainUnavailableError。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CareerStore } from './store';
import { loadResume } from './domain';

export const EXPORT_FORMATS = ['pdf', 'docx', 'png'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
};

export class ResumeNotFoundError extends Error {
  constructor(id: string) {
    super(`简历不存在：${id}`);
    this.name = 'ResumeNotFoundError';
  }
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

export async function exportResumeFile(
  store: CareerStore,
  id: string,
  format: ExportFormat,
  exportsDir: string,
  loader: () => Promise<typeof import('@career/resume')> = loadResume,
  /** 渲染前把简历 JSON 里的私密库占位符（{{vault:profile.phone}} 等）解成明文；只在这里发生，落库的 JSON 仍是占位符。 */
  resolve: (schema: unknown) => unknown = s => s,
): Promise<string> {
  const found = store.getResume(id);
  if (!found) throw new ResumeNotFoundError(id);
  const mod = await loader();
  const resume = mod.parseResume(resolve(JSON.parse(found.row.schema_json)));
  mkdirSync(exportsDir, { recursive: true });
  const path = join(exportsDir, `${id}.${format}`);
  let buffer: Buffer;
  if (format === 'docx') buffer = await mod.renderDocx(resume);
  else {
    const pdf = await mod.renderPdf(resume);
    buffer = format === 'pdf' ? pdf : await mod.renderPng(pdf);
  }
  writeFileSync(path, buffer);
  store.recordExport(id, format, path);
  return path;
}
