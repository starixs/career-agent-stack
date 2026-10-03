/**
 * 简历工作台的读写：内容权威在 resume_*.schema_json，排版文档在 resume_design（见 resume-studio-convert.ts）。
 *
 *  - loadStudio：排版文档对应的内容版本 == 当前内容 → 原样返回；否则（新简历 / 工具改过内容）按当前内容重建，
 *    保留已有排版，并落库。
 *  - saveStudio：工作台自动保存。校验文档 → 内容回写 schema_json（快照最多 10 分钟一次）→ 存排版文档。
 *  - 私密库占位符（{{vault:profile.phone}} 等）在文档里原样保留；预览需要的明文单独返回，只给渲染层画预览用，
 *    不会写回内容（所以模型侧永远看到的是占位符）。
 */
import type { Repos, Vault } from '@career/core';
import type { ResumeData } from '@career/resume-studio/schema';

import { fromStudio, toStudio } from './resume-studio-convert';
import type { CareerStore } from './store';

export const STUDIO_SNAPSHOT_INTERVAL_MS = 10 * 60_000;
const PLACEHOLDER_RX = /\{\{vault:[^}]+\}\}/g;

type StudioSchemaModule = typeof import('@career/resume-studio/schema');
type ResumeModule = typeof import('@career/resume');

export interface StudioDeps {
  repos: Repos;
  store: CareerStore;
  vault?: Pick<Vault, 'resolveDeep'> | null;
  studio?: () => Promise<StudioSchemaModule>;
  resume?: () => Promise<ResumeModule>;
  now?: () => Date;
}

const loadStudioSchema = () => import('@career/resume-studio/schema');
const loadResume = () => import('@career/resume');

export class StudioResumeNotFoundError extends Error {
  constructor(id: string) { super(`简历不存在：${id}`); this.name = 'StudioResumeNotFoundError'; }
}

/** 新简历的默认排版：中文页面、A4、onyx 模板（其余排版沿用 resume-studio 默认）。 */
export function defaultStudioBase(mod: StudioSchemaModule): ResumeData {
  const base = structuredClone(mod.defaultResumeData);
  base.metadata.page.locale = 'zh-CN';
  base.metadata.page.format = 'a4';
  return base;
}

export async function loadStudio(deps: StudioDeps, id: string): Promise<{ data: ResumeData; rebuilt: boolean; contentUpdatedAt: string }> {
  const found = deps.store.getResume(id);
  if (!found) throw new StudioResumeNotFoundError(id);
  const studioMod = await (deps.studio ?? loadStudioSchema)();
  const design = deps.repos.getResumeDesign(id);
  if (design && design.content_updated_at === found.row.updated_at) {
    return { data: studioMod.parseResumeData(JSON.parse(design.data_json)), rebuilt: false, contentUpdatedAt: found.row.updated_at };
  }
  const resumeMod = await (deps.resume ?? loadResume)();
  const content = resumeMod.parseResume(JSON.parse(found.row.schema_json || '{}'));
  const base = design ? studioMod.parseResumeData(JSON.parse(design.data_json)) : defaultStudioBase(studioMod);
  const data = studioMod.parseResumeData(toStudio(content, base));
  deps.repos.setResumeDesign(id, data, found.row.updated_at);
  return { data, rebuilt: true, contentUpdatedAt: found.row.updated_at };
}

export async function saveStudio(deps: StudioDeps, id: string, input: unknown): Promise<{ data: ResumeData; contentUpdatedAt: string; snapshot: boolean }> {
  const found = deps.store.getResume(id);
  if (!found) throw new StudioResumeNotFoundError(id);
  const studioMod = await (deps.studio ?? loadStudioSchema)();
  const resumeMod = await (deps.resume ?? loadResume)();
  const data = studioMod.parseResumeData(input);
  const prev = resumeMod.parseResume(JSON.parse(found.row.schema_json || '{}'));
  const next = resumeMod.parseResume(fromStudio(data, prev));
  const last = deps.store.lastSnapshotAt(id);
  const now = (deps.now ?? (() => new Date()))().getTime();
  const snapshot = !last || now - new Date(last).getTime() >= STUDIO_SNAPSHOT_INTERVAL_MS;
  const row = deps.store.saveResume(id, next, '简历工作台编辑前快照', { snapshot });
  deps.repos.setResumeDesign(id, data, row.updated_at);
  return { data, contentUpdatedAt: row.updated_at, snapshot };
}

/** 文档里出现的私密库占位符 → 明文（只给预览用；记访问日志）。 */
export function previewPlaceholders(deps: Pick<StudioDeps, 'vault'>, data: unknown, id: string): Record<string, string> {
  const found = new Set(JSON.stringify(data).match(PLACEHOLDER_RX) ?? []);
  if (!found.size || !deps.vault) return {};
  const keys = [...found];
  const resolved = deps.vault.resolveDeep(keys, { actor: 'ui', purpose: `简历工作台预览 ${id}` }) as unknown;
  const out: Record<string, string> = {};
  if (Array.isArray(resolved)) keys.forEach((k, i) => { const v = resolved[i]; if (typeof v === 'string' && v !== k) out[k] = v; });
  return out;
}

let nodeFontsReady = false;
/** 侧车渲染：模板字体优先用本机缓存文件，没缓存就用原 CDN 地址并在后台缓存一份（下次离线也能导出）。 */
async function prepareNodeFonts(): Promise<void> {
  if (nodeFontsReady) return;
  const [{ setWebFontUrlRewriter }, cache, fs] = await Promise.all([import('@career/resume-studio/fonts'), import('./font-cache'), import('fs')]);
  setWebFontUrlRewriter(url => {
    const path = cache.cachedFontPath(url);
    if (path && fs.existsSync(path)) return path;
    void cache.ensureFontCached(url).catch(() => { /* 下次再试 */ });
    return url;
  });
  nodeFontsReady = true;
}

/** 用工作台模板渲染 PDF（与预览同一套）；私密库占位符在这里解成明文，只进 PDF，不回写。 */
export async function renderStudioPdfBuffer(deps: StudioDeps, id: string, resolve: (doc: unknown) => unknown = d => d): Promise<Buffer> {
  const { data } = await loadStudio(deps, id);
  await prepareNodeFonts();
  const { createResumePdfFile } = await import('@career/resume-studio/server');
  const file = await createResumePdfFile({ data: resolve(data) as ResumeData, filename: `${id}.pdf` });
  return Buffer.from(await file.arrayBuffer());
}
