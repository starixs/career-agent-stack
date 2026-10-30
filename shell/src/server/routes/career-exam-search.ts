/**
 * Global 路由 `/api/career/exam-search/*`：笔试搜题（截图 / 文字 → 题库检索 → 答案）与题库管理。
 * 由 handleCareerRoute 转进来，响应格式与 /api/career/* 一致：`{ ok: true, ... }` / `{ ok: false, error }`。
 */
import type { LLM, LlmImage, Repos } from '@career/core';

import { loadCore } from '../career/core-module';
import { careerDataDir, getRepos } from '../career/db';
import { startImport } from '../career/exam-search/importer';
import { ExamSearchService, upcomingExamContexts } from '../career/exam-search/service';
import { getShellLLM } from '../career/llm';
import { broadcast as sseBroadcast } from '../sse';
import { fail, ok } from './career-response';

export const EXAM_SEARCH_PREFIX = '/api/career/exam-search/';

/** 截图走 JSON base64；一屏截图通常几百 KB，留足余量。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 题库文件上限：几十页 PDF / Word 足够。 */
const MAX_BANK_FILE_BYTES = 30 * 1024 * 1024;
/** 粘贴文字上限：一整页题目也就几千字。 */
const MAX_TEXT_CHARS = 20_000;

export interface ExamSearchRouteDeps {
  repos?: Repos;
  llm?: LLM;
  dataDir?: string;
  broadcast?: (event: string, data: unknown) => void;
}

type Json = Record<string, unknown>;
const IMAGE_TYPES: ReadonlyArray<LlmImage['mediaType']> = ['image/png', 'image/jpeg', 'image/webp'];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4);

function parseImage(v: unknown): LlmImage | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return 'invalid';
  const data = 'data' in v ? str(v.data) : null;
  const mediaType = IMAGE_TYPES.find(t => 'mediaType' in v && v.mediaType === t);
  if (!data || !mediaType) return 'invalid';
  return { mediaType, data };
}

function parseYear(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

async function readJson(request: Request): Promise<Json> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
  } catch (error) {
    console.warn(`[exam-search] 请求体不是 JSON：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function recognize(service: ExamSearchService, body: Json): Promise<Response> {
  const image = parseImage(body.image);
  if (image === 'invalid') return fail('截图格式不对：只支持 PNG、JPEG、WebP');
  const text = str(body.text);
  if (!image && !text) return fail('粘贴一张截图或一段题目文字');
  if (image && base64Bytes(image.data) > MAX_IMAGE_BYTES) return fail('截图太大了，截小一点再试');
  if (text && text.length > MAX_TEXT_CHARS) return fail(`文字太长了（超过 ${MAX_TEXT_CHARS} 字），分几次粘贴`);
  const search = await service.recognize({ image: image ?? undefined, text: text ?? undefined, companyName: str(body.company_name), roleTitle: str(body.role_title) });
  return ok({ search });
}

function importBank(service: ExamSearchService, body: Json, deps: Required<Pick<ExamSearchRouteDeps, 'llm' | 'dataDir' | 'broadcast'>>): Response {
  const fileName = str(body.file_name);
  const data = str(body.data);
  if (!fileName || !data) return fail('缺少文件');
  if (base64Bytes(data) > MAX_BANK_FILE_BYTES) return fail('文件太大了（超过 30MB），拆成几份再传');
  const bank = startImport(
    { fileName, data: Buffer.from(data, 'base64'), name: str(body.name), companyName: str(body.company_name), roleTitle: str(body.role_title), year: parseYear(body.year) },
    { bank: service.bank, llm: deps.llm, dataDir: deps.dataDir, onDone: () => deps.broadcast('career:data-changed', { sessionId: 'global', tables: ['exam_bank'] }) },
  );
  return ok({ bank });
}

async function dispatch(rest: string, method: string, request: Request, service: ExamSearchService, deps: Required<Pick<ExamSearchRouteDeps, 'llm' | 'dataDir' | 'broadcast' | 'repos'>>): Promise<Response | null> {
  if (method === 'POST' && rest === 'recognize') return recognize(service, await readJson(request));
  if (method === 'GET' && rest === 'history') return ok({ searches: service.list() });
  if (method === 'GET' && rest === 'contexts') return ok({ contexts: upcomingExamContexts(deps.repos.db) });
  if (method === 'GET' && rest === 'banks') return ok({ banks: service.bank.listBanks(), item_count: service.bank.itemCount() });
  if (method === 'POST' && rest === 'banks') return importBank(service, await readJson(request), deps);
  const bankId = /^banks\/([^/]+)$/.exec(rest)?.[1];
  if (method === 'DELETE' && bankId) return service.bank.deleteBank(decodeURIComponent(bankId)) ? ok() : fail('题库不存在', 404);
  const answerId = /^([^/]+)\/answer$/.exec(rest)?.[1];
  if (method === 'POST' && answerId) return ok({ search: await service.answer(decodeURIComponent(answerId)) });
  const searchId = /^([^/]+)$/.exec(rest)?.[1];
  if (method === 'DELETE' && searchId) return service.remove(decodeURIComponent(searchId)) ? ok() : fail('搜题记录不存在', 404);
  return null;
}

export async function handleExamSearchRoute(pathname: string, request: Request, deps: ExamSearchRouteDeps = {}): Promise<Response | null> {
  if (!pathname.startsWith(EXAM_SEARCH_PREFIX)) return null;
  const method = request.method.toUpperCase();
  const rest = pathname.slice(EXAM_SEARCH_PREFIX.length);
  try {
    const core = await loadCore();
    const repos = deps.repos ?? await getRepos();
    const llm = deps.llm ?? getShellLLM();
    const full = { repos, llm, dataDir: deps.dataDir ?? careerDataDir(), broadcast: deps.broadcast ?? sseBroadcast };
    const service = new ExamSearchService(repos.db, core, llm);
    return await dispatch(rest, method, request, service, full) ?? fail(`没有这个接口：${method} ${pathname}`, 404);
  } catch (error) {
    console.error(`[exam-search] ${method} ${pathname} 失败:`, error);
    return fail(error instanceof Error ? error.message : '内部错误', 500);
  }
}
