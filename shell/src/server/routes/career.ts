/**
 * Global 路由 `/api/career/*`（docs/API.md）：无会话依赖，直接读写求职 SQLite。
 *
 * - 浏览器三条（/api/career/browser/*）由 ./career-browser.ts 实现，这里返回 null 让其接管。
 * - 响应统一 `{ ok: true, ...data }` / `{ ok: false, error }`。
 * - 依赖通过 `deps` 注入（测试用 :memory: Db），缺省取进程单例。
 * - 导出接口依赖 @career/resume；包未就绪返回 501 并给中文说明。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Repos, ApplicationStage, LLM } from '@career/core';

import { CareerStore, DIRECTION_STATUSES } from '../career/store';
import { loadCore, type CoreModule } from '../career/core-module';
import { getRepos, careerExportsDir } from '../career/db';
import { DomainUnavailableError } from '../career/domain';
import { EXPORT_FORMATS, EXPORT_MIME, ResumeNotFoundError, exportResumeFile, type ExportFormat } from '../career/export';
import { getShellLLM } from '../career/llm';
import { loadSkillPrompt } from '../career/skills';
import { broadcast as sseBroadcast } from '../sse';

export interface CareerRouteDeps {
  repos?: Repos;
  broadcast?: (event: string, data: unknown) => void;
  sessionId?: () => string;
  exportsDir?: string;
  /** undefined → 进程共享 ShellLLM；null → 不调用模型（导入岗位时不解析 JD）。 */
  llm?: LLM | null;
  resumeModule?: () => Promise<typeof import('@career/resume')>;
}

type Json = Record<string, unknown>;

export function careerJson(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export const ok = (data: Json = {}, status = 200) => careerJson({ ok: true, ...data }, status);
export const fail = (error: string, status = 400) => careerJson({ ok: false, error }, status);

async function readBody(request: Request): Promise<Json> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as Json : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strOrNull = (v: unknown): string | null | undefined => (v === null ? null : str(v));

interface Ctx {
  request: Request;
  url: URL;
  params: Record<string, string>;
  body: Json;
  repos: Repos;
  store: CareerStore;
  core: CoreModule;
  deps: Required<Pick<CareerRouteDeps, 'broadcast' | 'sessionId' | 'exportsDir'>> & CareerRouteDeps;
}

type Handler = (ctx: Ctx) => Promise<Response> | Response;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z_]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

function dataChanged(ctx: Ctx, tables: string[]): void {
  ctx.deps.broadcast('career:data-changed', { sessionId: ctx.deps.sessionId(), tables });
}

function exportResume(ctx: Ctx, id: string, format: ExportFormat): Promise<string> {
  return exportResumeFile(ctx.store, id, format, ctx.deps.exportsDir, ctx.deps.resumeModule);
}

const ROUTES: Route[] = [
  route('GET', '/api/career/overview', ({ store }) => ok(store.overview())),

  // ---------- 经历库 ----------
  route('GET', '/api/career/experiences', ({ repos }) => ok({ experiences: repos.experienceTree() })),
  route('POST', '/api/career/experiences', (ctx) => {
    const title = str(ctx.body.title);
    if (!title) return fail('title 不能为空');
    const b = ctx.body;
    const experience = ctx.repos.createExperience({
      title, role: strOrNull(b.role), org: strOrNull(b.org), start_date: strOrNull(b.start_date), end_date: strOrNull(b.end_date),
      type: str(b.type), summary: strOrNull(b.summary), redacted: b.redacted ? 1 : 0,
    });
    dataChanged(ctx, ['experience']);
    return ok({ experience });
  }),
  route('POST', '/api/career/claims', (ctx) => {
    const experience_id = str(ctx.body.experience_id); const text = str(ctx.body.text);
    if (!experience_id || !text) return fail('experience_id 与 text 不能为空');
    try {
      const attribution = ctx.body.attribution;
      const claim = ctx.repos.addClaim({
        experience_id, text,
        attribution: attribution === 'self' || attribution === 'team' || attribution === 'unknown' ? attribution : undefined,
        result_metric: strOrNull(ctx.body.result_metric), created_from: str(ctx.body.created_from),
      });
      dataChanged(ctx, ['claim']);
      return ok({ claim });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入主张失败');
    }
  }),
  route('POST', '/api/career/claims/:id/confirm', (ctx) => {
    const before = ctx.repos.listClaims().find(c => c.id === ctx.params.id);
    if (!before) return fail(`主张不存在：${ctx.params.id}`, 404);
    ctx.repos.confirmClaim(ctx.params.id);
    dataChanged(ctx, ['claim']);
    return ok({ claim: ctx.repos.listClaims(before.experience_id).find(c => c.id === ctx.params.id) });
  }),
  route('POST', '/api/career/evidence', (ctx) => {
    const claim_id = str(ctx.body.claim_id); const kind = str(ctx.body.kind); const locator = str(ctx.body.locator);
    if (!claim_id || !kind || !locator) return fail('claim_id / kind / locator 不能为空');
    try {
      const strength = ctx.body.strength;
      const evidence = ctx.repos.addEvidence({ claim_id, kind, locator, excerpt: strOrNull(ctx.body.excerpt), strength: strength === 'strong' || strength === 'mid' || strength === 'weak' ? strength : undefined });
      dataChanged(ctx, ['evidence']);
      return ok({ evidence });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入证据失败');
    }
  }),

  // ---------- 简历 ----------
  route('GET', '/api/career/resumes', ({ store }) => ok({ masters: store.listResumeMasters(), tailored: store.listResumeTailored() })),
  route('POST', '/api/career/resumes/master', (ctx) => {
    const name = str(ctx.body.name);
    if (!name) return fail('name 不能为空');
    const master = ctx.store.createResumeMaster({ name, direction: strOrNull(ctx.body.direction), schema_json: ctx.body.schema_json });
    dataChanged(ctx, ['resume_master']);
    return ok({ master });
  }),
  route('PUT', '/api/career/resumes/:id', (ctx) => {
    if (ctx.body.schema_json === undefined) return fail('schema_json 不能为空');
    try {
      const resume = ctx.store.saveResume(ctx.params.id, ctx.body.schema_json);
      dataChanged(ctx, ['resume_master', 'resume_tailored', 'resume_snapshot']);
      return ok({ resume });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '保存失败', 404);
    }
  }),
  route('POST', '/api/career/resumes/:id/export', async (ctx) => {
    const format = ctx.body.format;
    if (!EXPORT_FORMATS.includes(format as ExportFormat)) return fail("format 必须是 'pdf' | 'docx' | 'png'");
    try {
      const path = await exportResume(ctx, ctx.params.id, format as ExportFormat);
      dataChanged(ctx, ['resume_tailored']);
      return ok({ path });
    } catch (error) {
      if (error instanceof ResumeNotFoundError) return fail(error.message, 404);
      if (error instanceof DomainUnavailableError) return fail(`导出功能尚未就绪：${error.message}`, 501);
      return fail(error instanceof Error ? error.message : '导出失败', 500);
    }
  }),
  route('GET', '/api/career/resumes/:id/file', async (ctx) => {
    const format = (ctx.url.searchParams.get('format') ?? 'pdf') as ExportFormat;
    if (!EXPORT_FORMATS.includes(format)) return fail("format 必须是 'pdf' | 'docx' | 'png'");
    try {
      let path = join(ctx.deps.exportsDir, `${ctx.params.id}.${format}`);
      if (!existsSync(path)) path = await exportResume(ctx, ctx.params.id, format);
      return new Response(readFileSync(path), { status: 200, headers: { 'Content-Type': EXPORT_MIME[format], 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof ResumeNotFoundError) return fail(error.message, 404);
      if (error instanceof DomainUnavailableError) return fail(`预览功能尚未就绪：${error.message}`, 501);
      return fail(error instanceof Error ? error.message : '读取文件失败', 500);
    }
  }),

  // ---------- 岗位 ----------
  route('GET', '/api/career/jobs', ({ repos }) => ok({ jobs: repos.listJobs() })),
  route('POST', '/api/career/jobs/import', async (ctx) => {
    const url = str(ctx.body.url); const jd_raw = str(ctx.body.jd_raw);
    if (!url && !jd_raw) return fail('url 或 jd_raw 至少提供一个');
    let title = str(ctx.body.title);
    if (!title) title = jd_raw?.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 60) ?? (url ? safeHostname(url) : '未命名岗位');
    const job = ctx.repos.upsertJob({
      source_platform: str(ctx.body.source_platform) ?? 'manual', title, url: url ?? null, jd_raw: jd_raw ?? null,
      company_name: strOrNull(ctx.body.company_name), source_job_id: str(ctx.body.source_job_id) ?? null,
    });
    let parsed: unknown;
    const llm = ctx.deps.llm === undefined ? getShellLLM() : ctx.deps.llm;
    if (jd_raw && llm) {
      try {
        const system = await loadSkillPrompt('jd-parse');
        const res = await llm.complete({ system, messages: [{ role: 'user', content: `公司：${job.company_name ?? '未知'}\n岗位：${job.title}\n\nJD 原文：\n${jd_raw}` }], json: true, temperature: 0.2 });
        parsed = ctx.core.extractJson(res.text);
        ctx.repos.db.update('job', job.id, { jd_parsed_json: JSON.stringify(parsed), updated_at: new Date().toISOString() });
      } catch (error) {
        console.warn('[career] 导入岗位时解析 JD 失败（已保存原文）:', error instanceof Error ? error.message : error);
      }
    }
    dataChanged(ctx, ['job']);
    return ok({ job: ctx.repos.getJob(job.id), ...(parsed !== undefined ? { jd_parsed: parsed } : {}) });
  }),

  // ---------- 投递台 ----------
  route('GET', '/api/career/applications', ({ store }) => ok({ applications: store.listApplicationsWithJob() })),
  route('GET', '/api/career/board', ({ repos }) => ok({ board: repos.board() })),
  route('POST', '/api/career/applications/:id/stage', (ctx) => {
    const to = str(ctx.body.to) as ApplicationStage | undefined;
    const stages = ctx.core.APPLICATION_STAGES;
    if (!to || !stages.includes(to)) return fail(`to 必须是合法阶段：${stages.join(' | ')}`);
    try {
      const extra = ctx.body.extra && typeof ctx.body.extra === 'object' ? ctx.body.extra as Json : {};
      const application = ctx.repos.transition(ctx.params.id, to, str(ctx.body.note), extra);
      dataChanged(ctx, ['application']);
      return ok({ application });
    } catch (error) {
      const message = error instanceof Error ? error.message : '阶段流转失败';
      return fail(message, message.includes('不存在') ? 404 : 409);
    }
  }),

  // ---------- 动作队列 ----------
  route('GET', '/api/career/actions', ({ repos, url }) => ok({ actions: repos.listActions(url.searchParams.get('status') ?? undefined) })),
  route('POST', '/api/career/actions/review', (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.filter((x): x is string => typeof x === 'string') : [];
    const decision = ctx.body.decision;
    if (!ids.length) return fail('ids 不能为空');
    if (decision !== 'approved' && decision !== 'rejected') return fail("decision 必须是 'approved' | 'rejected'");
    const n = ctx.repos.reviewActions(ids, decision);
    dataChanged(ctx, ['action_queue']);
    return ok({ n });
  }),

  // ---------- 接管 ----------
  route('GET', '/api/career/handoffs', ({ repos }) => ok({ handoffs: repos.openHandoffs() })),
  route('POST', '/api/career/handoffs/:id/close', (ctx) => {
    try {
      const handoff = ctx.repos.closeHandoff(ctx.params.id, str(ctx.body.resumed_from_step));
      dataChanged(ctx, ['handoff', 'task', 'action_queue']);
      return ok({ handoff });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '关闭接管失败', 404);
    }
  }),

  // ---------- 任务 / 公司 ----------
  route('GET', '/api/career/tasks', ({ repos }) => ok({ tasks: repos.listTasks() })),
  route('GET', '/api/career/companies', ({ store }) => ok({ companies: store.listCompanies() })),

  // ---------- 面试 ----------
  route('GET', '/api/career/interviews', ({ store }) => ok({ interviews: store.listInterviews() })),
  route('POST', '/api/career/interviews', (ctx) => {
    const interview = ctx.store.createInterview(ctx.body as never);
    dataChanged(ctx, ['interview']);
    return ok({ interview });
  }),
  route('PUT', '/api/career/interviews/:id', (ctx) => {
    try {
      const interview = ctx.store.updateInterview(ctx.params.id, ctx.body as never);
      dataChanged(ctx, ['interview']);
      return ok({ interview });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '更新失败', 404);
    }
  }),
  route('GET', '/api/career/mock-interviews', ({ store }) => ok({ mockInterviews: store.listMockInterviews() })),

  // ---------- 方向 / 差距 / Offer ----------
  route('GET', '/api/career/directions', ({ store }) => ok({ directions: store.listDirections() })),
  route('POST', '/api/career/directions/:id/status', (ctx) => {
    const status = ctx.body.status;
    if (!DIRECTION_STATUSES.includes(status as never)) return fail(`status 必须是：${DIRECTION_STATUSES.join(' | ')}`);
    try {
      const direction = ctx.store.setDirectionStatus(ctx.params.id, status as never);
      dataChanged(ctx, ['direction']);
      return ok({ direction });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '更新失败', 404);
    }
  }),
  route('GET', '/api/career/gap-plans', ({ store }) => ok({ gapPlans: store.listGapPlans() })),
  route('GET', '/api/career/offers', ({ store }) => ok({ offers: store.listOffers() })),
  route('POST', '/api/career/offers', (ctx) => {
    const offer = ctx.store.createOffer(ctx.body as never);
    dataChanged(ctx, ['offer']);
    return ok({ offer });
  }),
  route('PUT', '/api/career/offers/:id', (ctx) => {
    try {
      const offer = ctx.store.updateOffer(ctx.params.id, ctx.body as never);
      dataChanged(ctx, ['offer']);
      return ok({ offer });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '更新失败', 404);
    }
  }),

  // ---------- 答案库 ----------
  route('GET', '/api/career/answer-bank', ({ store }) => ok({ answers: store.listAnswerBank() })),
  route('POST', '/api/career/answer-bank', (ctx) => {
    const question_key = str(ctx.body.question_key); const question_text = str(ctx.body.question_text); const answer = str(ctx.body.answer);
    if (!question_key || !question_text || !answer) return fail('question_key / question_text / answer 不能为空');
    ctx.repos.saveAnswer({ question_key, question_text, answer, high_impact: !!ctx.body.high_impact, confirmed: !!ctx.body.confirmed });
    dataChanged(ctx, ['answer_bank']);
    return ok({ answer: ctx.repos.findAnswer(question_key) });
  }),
];

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return '未命名岗位'; }
}

/** 入口：非 `/api/career/` 或浏览器子路径返回 null。 */
export async function handleCareerRoute(pathname: string, request: Request, deps: CareerRouteDeps = {}): Promise<Response | null> {
  if (!pathname.startsWith('/api/career/') || pathname.startsWith('/api/career/browser/')) return null;
  const method = request.method.toUpperCase();
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    let core: CoreModule;
    let repos: Repos;
    try {
      core = await loadCore();
      repos = deps.repos ?? await getRepos();
    } catch (error) {
      return fail(error instanceof Error ? error.message : '求职数据层不可用', 503);
    }
    const ctx: Ctx = {
      request, url: new URL(request.url), params, repos, core, store: new CareerStore(repos, core),
      body: method === 'GET' ? {} : await readBody(request),
      deps: { ...deps, broadcast: deps.broadcast ?? sseBroadcast, sessionId: deps.sessionId ?? (() => 'global'), exportsDir: deps.exportsDir ?? careerExportsDir() },
    };
    try {
      return await r.handler(ctx);
    } catch (error) {
      console.error(`[career] ${method} ${pathname} 失败:`, error);
      return fail(error instanceof Error ? error.message : '内部错误', 500);
    }
  }
  // 前缀命中但没有匹配的接口：按 API.md 返回 404 JSON，而不是落到前端静态文件。
  return fail(`未知接口：${method} ${pathname}`, 404);
}
