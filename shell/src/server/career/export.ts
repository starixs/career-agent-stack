/**
 * 简历导出：写到 `CAREER_DATA_DIR/exports/<id>.<ext>`。路由与工具共用；领域库未就绪时抛 DomainUnavailableError。
 *  - PDF / 图片：传了 studio（repos）时用简历工作台的模板（与工作台预览同一套），否则用 @career/resume 的默认模板；
 *  - Word：始终按内容由 @career/resume 生成（模板是 PDF 专用的）。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repos } from '@career/core';

import { renderStudioPdfBuffer } from './resume-studio';
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
  studio?: { repos: Repos } | null,
  /** 过机筛模式：单栏、无照片的标准模板（不用工作台模板）；缺省按 kv `resume:ats:<id>`。 */
  opts: { ats?: boolean } = {},
): Promise<string> {
  const found = store.getResume(id);
  if (!found) throw new ResumeNotFoundError(id);
  const mod = await loader();
  const resume = mod.parseResume(resolve(JSON.parse(found.row.schema_json)));
  mkdirSync(exportsDir, { recursive: true });
  const path = join(exportsDir, `${id}.${format}`);
  const ats = opts.ats ?? (studio ? isAtsMode(studio.repos, id) : false);
  let buffer: Buffer;
  if (format === 'docx') buffer = await mod.renderDocx(resume);
  else {
    const pdf = ats
      ? await mod.renderPdf(resume, { ats: true })
      : studio
      ? await renderStudioPdfBuffer({ repos: studio.repos, store }, id, resolve)
      : await mod.renderPdf(resume);
    buffer = format === 'pdf' ? pdf : await mod.renderPng(pdf);
  }
  writeFileSync(path, buffer);
  store.recordExport(id, format, path);
  return path;
}

/** 这份简历是否开了过机筛模式（导出、投递材料包都用 ATS 版）。 */
export const atsKey = (resumeId: string) => `resume:ats:${resumeId}`;
export function isAtsMode(repos: Pick<Repos, 'kvGet'>, resumeId: string): boolean { return repos.kvGet<boolean>(atsKey(resumeId)) === true; }
export function setAtsMode(repos: Pick<Repos, 'kvSet'>, resumeId: string, enabled: boolean): void { repos.kvSet(atsKey(resumeId), enabled); }
