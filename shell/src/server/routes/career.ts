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
import type { Repos, ApplicationStage, JobPrefs, LLM, Vault, VaultScope } from '@career/core';

import { CareerStore, DIRECTION_STATUSES } from '../career/store';
import { StudioResumeNotFoundError, loadStudio, previewPlaceholders, saveStudio } from '../career/resume-studio';
import { careerSetupStatus } from '../career/setup';
import { confirmTailorProposal } from '../career/tailor';
import { loadCore, type CoreModule } from '../career/core-module';
import { getRepos, careerExportsDir } from '../career/db';
import { DomainUnavailableError, loadBridges } from '../career/domain';
import { EXPORT_FORMATS, EXPORT_MIME, ResumeNotFoundError, exportResumeFile, isAtsMode, setAtsMode, type ExportFormat } from '../career/export';
import { runAtsCheck } from '../career/ats-check';
import { getShellLLM } from '../career/llm';
import { captureIntake, captureLink, recordExam, type IntakeDeps } from '../career/intake';
import { deleteMailPassword, setMailPassword } from '../career/mail/credentials';
import { MAIL_PRESETS, detectProvider, presetFor } from '../career/mail/providers';
import { executeApprovedSendMails } from '../career/mail/send';
import { syncAllMailAccounts, syncMailAccount, verifyImapLogin } from '../career/mail/sync';
import { RECIPES, cancelMailConnect, fromPlaywrightPage, getMailConnect, isConnectProvider, provideConnectAddress, startMailConnect, type ConnectDeps } from '../career/mail/connect';
import { draftMaterial } from '../career/materials';
import { generateWeeklyReview } from '../career/review';
import { loadSkillPrompt } from '../career/skills';
import { getVault, vaultForRepos } from '../career/vault';
import { LEARN_THRESHOLD, getAutoMode, resetPageTrust, setAutoMode } from '../career/submit-policy';
import { confirmSubmitResult } from '../career/submit-executor';
import { clearAccountFetch, isAccountField, listAccountFetch, requestAccountFetch } from '../career/accounts';
import { BatchRunner } from '../career/batch-runner';
import { CAMPUS_SEEDED_KEY, computeMatches, getJobPrefs, jobBoard, prepareJobs, seedCampusJobsIfEmpty, setJobPrefs } from '../career/job-board';
import { RemoteJobSource, SERVER_CONFIG_KEY, serverConfig, syncJobSource } from '../career/server-api';
import { exportCareerWorkbook } from '../career/xlsx-export';
import { broadcast as sseBroadcast } from '../sse';

export interface CareerRouteDeps {
  repos?: Repos;
  /** 私密信息库；缺省按 repos 的连接构造（测试注入 StaticKeyProvider 的实例）。 */
  vault?: Vault;
  broadcast?: (event: string, data: unknown) => void;
  sessionId?: () => string;
  exportsDir?: string;
  /** undefined → 进程共享 ShellLLM；null → 不调用模型（导入岗位时不解析 JD）。 */
  llm?: LLM | null;
  resumeModule?: () => Promise<typeof import('@career/resume')>;
  /** 邮箱一键连接借页面 / 试登录（测试注入；缺省走产品浏览器与真实 IMAP）。 */
  mailConnect?: Partial<Pick<ConnectDeps, 'withPage' | 'verifyLogin' | 'tickMs' | 'sleep'>>;
  /** false：导出不用简历工作台模板（测试里没有 react-pdf 字体网络时用）。 */
  studioExport?: boolean;
}

type Json = Record<string, unknown>;

export function careerJson(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export const ok = (data: Json = {}, status = 200) => careerJson({ ok: true, ...data }, status);
export const fail = (error: string, status = 400) => careerJson({ ok: false, error }, status);

function parseJsonObj(raw: string | null | undefined): Json {
  try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? v as Json : {}; } catch { return {}; }
}
/** 提交执行器与页面释放只在 Global 侧车（浏览器宿主所在进程）可用；动态加载避免路由模块拉起浏览器依赖。 */
async function kickSubmit(): Promise<void> {
  try { const { kickSubmitExecutor } = await import('../career/batch-service'); await kickSubmitExecutor(); } catch { /* 轮询会兜底 */ }
}
async function releasePage(applicationId: string): Promise<void> {
  try { const { releaseApplicationPageFor } = await import('../career/batch-service'); await releaseApplicationPageFor(applicationId); } catch { /* ignore */ }
}

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
  vault: Vault;
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

/** 路由 → 共享服务（收件箱 / 邮箱 / 复盘 / 素材）的依赖；llm: undefined → 进程 ShellLLM，null → 不调模型。 */
function intakeDeps(ctx: Ctx): IntakeDeps {
  let llm: IntakeDeps['llm'] = null;
  if (ctx.deps.llm === undefined) { try { llm = getShellLLM(); } catch { llm = null; } } else llm = ctx.deps.llm;
  return { repos: ctx.repos, core: ctx.core, llm, broadcast: ctx.deps.broadcast, sessionId: ctx.deps.sessionId };
}
const isoOrUndefined = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

function exportResume(ctx: Ctx, id: string, format: ExportFormat): Promise<string> {
  // 占位符 → 明文只在渲染这一刻发生；落库 JSON 与模型看到的仍是 {{vault:...}}
  return exportResumeFile(ctx.store, id, format, ctx.deps.exportsDir, ctx.deps.resumeModule, schema => ctx.vault.resolveDeep(schema, { actor: 'resume_export', purpose: `导出简历 ${id} ${format}` }), ctx.deps.studioExport === false ? null : { repos: ctx.repos });
}

const VAULT_SCOPES: readonly VaultScope[] = ['profile', 'site', 'experience'];
const isVaultScope = (v: unknown): v is VaultScope => typeof v === 'string' && (VAULT_SCOPES as readonly string[]).includes(v);

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
  // ---------- 简历工作台（resume-studio 文档：内容 + 模板 / 布局 / 字体 / 配色） ----------
  route('GET', '/api/career/resumes/:id/studio', async (ctx) => {
    try {
      const out = await loadStudio({ repos: ctx.repos, store: ctx.store, vault: ctx.vault }, ctx.params.id);
      return ok({ data: out.data, content_updated_at: out.contentUpdatedAt, rebuilt: out.rebuilt, preview: previewPlaceholders({ vault: ctx.vault }, out.data, ctx.params.id) });
    } catch (error) {
      if (error instanceof StudioResumeNotFoundError) return fail(error.message, 404);
      return fail(error instanceof Error ? error.message : '读取简历工作台失败', 500);
    }
  }),
  route('PUT', '/api/career/resumes/:id/studio', async (ctx) => {
    if (!ctx.body.data || typeof ctx.body.data !== 'object') return fail('data 必须是简历工作台文档');
    try {
      const out = await saveStudio({ repos: ctx.repos, store: ctx.store }, ctx.params.id, ctx.body.data);
      dataChanged(ctx, ['resume_master', 'resume_tailored', ...(out.snapshot ? ['resume_snapshot'] : [])]);
      return ok({ content_updated_at: out.contentUpdatedAt, snapshot: out.snapshot, preview: previewPlaceholders({ vault: ctx.vault }, out.data, ctx.params.id) });
    } catch (error) {
      if (error instanceof StudioResumeNotFoundError) return fail(error.message, 404);
      return fail(error instanceof Error ? error.message : '保存失败', 400);
    }
  }),

  /** 对话内「简历改动」卡片：只应用用户勾选的路径（缺省全部），与 resume_confirm 工具同一条路径。 */
  route('POST', '/api/career/resumes/:id/confirm', (ctx) => {
    const accepted = Array.isArray(ctx.body.accepted_paths) ? (ctx.body.accepted_paths as unknown[]).filter((p): p is string => typeof p === 'string') : undefined;
    const result = confirmTailorProposal(ctx.store, ctx.repos, ctx.params.id, accepted);
    if (!result) return fail(`定制简历不存在：${ctx.params.id}`, 404);
    dataChanged(ctx, ['resume_tailored', 'resume_snapshot']);
    return ok({ tailored: result.tailored, applied_ops: result.applied });
  }),
  // 过机筛开关：开了之后导出与投递材料包都用单栏无照片的 ATS 版；自检按当前设置导出后抽文字对照
  route('GET', '/api/career/resumes/:id/ats', ({ repos, params }) => ok({ enabled: isAtsMode(repos, params.id) })),
  route('PUT', '/api/career/resumes/:id/ats', (ctx) => {
    if (!ctx.store.getResume(ctx.params.id)) return fail(`简历不存在：${ctx.params.id}`, 404);
    setAtsMode(ctx.repos, ctx.params.id, ctx.body.enabled === true);
    dataChanged(ctx, ['kv', 'resume']);
    return ok({ enabled: ctx.body.enabled === true });
  }),
  route('POST', '/api/career/resumes/:id/ats-check', async (ctx) => {
    try {
      const report = await runAtsCheck({ store: ctx.store, exportPdf: id => exportResume(ctx, id, 'pdf'), resolve: schema => ctx.vault.resolveDeep(schema, { actor: 'resume_export', purpose: `过机筛自检 ${ctx.params.id}` }) }, ctx.params.id);
      return ok({ report: { ...report, pdf_path: undefined }, ats_mode: isAtsMode(ctx.repos, ctx.params.id) });
    } catch (error) {
      if (error instanceof DomainUnavailableError) return fail(error.message, 501);
      return fail(error instanceof Error ? error.message : '自检失败', error instanceof Error && error.message.includes('不存在') ? 404 : 500);
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
    // 汇总表维度（见 job-board.ts 顶部约定）：用户填了批次 / 行业 / 类型标签就用；否则只取原文里字面出现的批次词
    const typeTags = Array.isArray(ctx.body.type_tags) ? ctx.body.type_tags.filter((x): x is string => typeof x === 'string') : [];
    const job = ctx.repos.upsertJob({
      source_platform: str(ctx.body.source_platform) ?? 'manual', title, url: url ?? null, jd_raw: jd_raw ?? null,
      company_name: strOrNull(ctx.body.company_name), source_job_id: str(ctx.body.source_job_id) ?? null,
      board_json: ctx.core.serializeBoardMeta({ batch: str(ctx.body.batch) ?? ctx.core.batchFromText(title, jd_raw), industry: str(ctx.body.industry), type_tags: typeTags }),
    });
    let parsed: unknown;
    const llm = ctx.deps.llm === undefined ? getShellLLM() : ctx.deps.llm;
    if (jd_raw && llm) {
      try {
        const system = await loadSkillPrompt('jd-parse');
        const res = await llm.complete({ system, messages: [{ role: 'user', content: `公司：${job.company_name ?? '未知'}\n岗位：${job.title}\n\nJD 原文：\n${jd_raw}` }], json: true, temperature: 0.2 });
        parsed = ctx.core.extractJson(res.text);
        // JD 解析补充的维度只填空缺：用户手填的优先
        const fromJd = ctx.core.parseBoardJson(ctx.core.serializeBoardMeta(ctx.core.boardMetaFromJd(parsed as Parameters<CoreModule['boardMetaFromJd']>[0], jd_raw)));
        const board = fromJd ? JSON.stringify(ctx.core.mergeBoardMeta(fromJd, ctx.core.parseBoardJson(job.board_json))) : undefined;
        ctx.repos.db.update('job', job.id, { jd_parsed_json: JSON.stringify(parsed), ...(board ? { board_json: board } : {}), updated_at: new Date().toISOString() });
      } catch (error) {
        console.warn('[career] 导入岗位时解析 JD 失败（已保存原文）:', error instanceof Error ? error.message : error);
      }
    }
    dataChanged(ctx, ['job']);
    return ok({ job: ctx.repos.getJob(job.id), ...(parsed !== undefined ? { jd_parsed: parsed } : {}) });
  }),

  // ---------- 岗位汇总表（R01 / R02 / R06 / R08） ----------
  route('GET', '/api/career/jobs/board', async (ctx) => {
    const { repos, url } = ctx;
    // 首次打开：岗位表为空就自动导入一次内置校招数据（幂等，只跑一次；领域库 / 数据缺失时照常返回空表）
    if (!repos.kvGet<string>(CAMPUS_SEEDED_KEY)) {
      const seeded = await loadBridges().then(b => seedCampusJobsIfEmpty(repos, ctx.store, b), () => null);
      if (seeded?.stored) dataChanged(ctx, ['job']);
    }
    const p = url.searchParams;
    const progress = p.get('progress');
    const sort = p.get('sort');
    return ok({ rows: jobBoard(repos, {
      q: p.get('q') ?? undefined, employment_type: p.get('employment_type') ?? undefined, city: p.get('city') ?? undefined, cohort: p.get('cohort') ?? undefined,
      open_only: p.get('open_only') === '1', fits_only: p.get('fits_only') === '1',
      progress: progress === 'none' || progress === 'active' || progress === 'done' ? progress : undefined,
      sort: sort === 'deadline' || sort === 'updated' || sort === 'match' ? sort : undefined,
      limit: Number(p.get('limit')) || undefined,
    }), prefs: getJobPrefs(repos), server: !!serverConfig(repos) });
  }),
  route('POST', '/api/career/jobs/match', (ctx) => {
    const ids = Array.isArray(ctx.body.job_ids) ? ctx.body.job_ids.filter((x): x is string => typeof x === 'string') : undefined;
    const n = computeMatches(ctx.repos, ctx.store, ids);
    dataChanged(ctx, ['job']);
    return ok({ n });
  }),
  route('GET', '/api/career/job-prefs', ({ repos }) => ok({ prefs: getJobPrefs(repos) })),
  route('PUT', '/api/career/job-prefs', (ctx) => {
    const b = ctx.body;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const prefs = setJobPrefs(ctx.repos, { cohort: strOrNull(b.cohort), degree: strOrNull(b.degree), cities: list(b.cities), employment_types: list(b.employment_types) as JobPrefs['employment_types'], keywords: list(b.keywords) });
    const n = computeMatches(ctx.repos, ctx.store);
    dataChanged(ctx, ['job', 'kv']);
    return ok({ prefs, rematched: n });
  }),
  route('POST', '/api/career/jobs/sync', async (ctx) => {
    const source = ctx.body.source === 'server' ? 'server' : 'campus';
    try {
      let result: { fetched: number; stored: number };
      if (source === 'server') {
        const cfg = serverConfig(ctx.repos);
        if (!cfg) return fail('还没有配置服务端地址（设置 → 求职助理 → 服务端，或环境变量 CAREER_API_BASE_URL）', 409);
        const since = ctx.repos.kvGet<string>('jobs:server:synced_at') ?? undefined;
        result = await syncJobSource(ctx.repos, new RemoteJobSource(cfg), { updated_since: since });
        ctx.repos.kvSet('jobs:server:synced_at', new Date().toISOString());
      } else {
        const bridges = await loadBridges();
        const items = bridges.filterCampusJobs(bridges.loadCampusJobs(), { excludeExpired: false });
        const stored = bridges.importCampusJobs(ctx.repos, items).length;
        result = { fetched: items.length, stored };
      }
      const matched = computeMatches(ctx.repos, ctx.store);
      dataChanged(ctx, ['job']);
      return ok({ source, ...result, matched });
    } catch (error) {
      if (error instanceof DomainUnavailableError) return fail(error.message, 501);
      return fail(error instanceof Error ? error.message : '同步失败', 502);
    }
  }),
  route('POST', '/api/career/jobs/prepare', async (ctx) => {
    const ids = Array.isArray(ctx.body.job_ids) ? ctx.body.job_ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) return fail('job_ids 不能为空');
    try {
      const results = await prepareJobs({ repos: ctx.repos, store: ctx.store, exportPdf: id => exportResume(ctx, id, 'pdf'), exportsDir: ctx.deps.exportsDir }, ids, str(ctx.body.resume_id) ?? null);
      dataChanged(ctx, ['application', 'action_queue']);
      return ok({ results, queued: results.filter(r => r.ok).length });
    } catch (error) {
      if (error instanceof DomainUnavailableError) return fail(error.message, 501);
      throw error;
    }
  }),
  route('POST', '/api/career/export/workbook', async (ctx) => {
    const res = await exportCareerWorkbook(ctx.repos, ctx.deps.exportsDir);
    return ok(res);
  }),
  route('GET', '/api/career/server-config', ({ repos }) => {
    const cfg = serverConfig(repos);
    return ok({ configured: !!cfg, base_url: cfg?.base_url ?? null, has_token: !!cfg?.token, pending_answer_events: repos.pendingAnswerEvents(1000).length });
  }),
  route('PUT', '/api/career/server-config', (ctx) => {
    const base = str(ctx.body.base_url);
    if (base && !/^https?:\/\//i.test(base)) return fail('base_url 必须是 http(s) 地址');
    const cur = ctx.repos.kvGet<{ base_url: string; token?: string }>(SERVER_CONFIG_KEY);
    if (!base) ctx.repos.kvSet(SERVER_CONFIG_KEY, null);
    else ctx.repos.kvSet(SERVER_CONFIG_KEY, { base_url: base, token: typeof ctx.body.token === 'string' ? ctx.body.token : cur?.token });
    dataChanged(ctx, ['kv']);
    return ok({ configured: !!base });
  }),

  // ---------- 经历访谈进度（R03） ----------
  route('GET', '/api/career/experience-progress', ({ repos, core }) => ok({ progress: core.interviewProgress(repos.experienceTree(), repos.kvGet(core.INTERVIEW_STATE_KEY) ?? { rounds: {} }) })),

  // ---------- 题库（R09） ----------
  route('GET', '/api/career/questions', ({ repos, url }) => {
    const p = url.searchParams;
    const kind = p.get('kind'); const source = p.get('source');
    return ok({ questions: repos.listQuestions({
      kind: kind === 'interview' || kind === 'written' || kind === 'assessment' ? kind : undefined,
      source: source === 'public' || source === 'seen' || source === 'generated' ? source : undefined,
      company: p.get('company') ?? undefined, q: p.get('q') ?? undefined, weak_only: p.get('weak_only') === '1', job_id: p.get('job_id') ?? undefined,
    }) });
  }),
  route('POST', '/api/career/questions', (ctx) => {
    const content = str(ctx.body.content);
    if (!content) return fail('content 不能为空');
    const kind = ctx.body.kind === 'written' || ctx.body.kind === 'assessment' ? ctx.body.kind : 'interview';
    const q = ctx.repos.upsertQuestion({ content, kind, category: strOrNull(ctx.body.category), company_name: strOrNull(ctx.body.company_name), title: strOrNull(ctx.body.title), source: ctx.body.source === 'public' ? 'public' : 'seen', source_ref: 'user' });
    dataChanged(ctx, ['question']);
    return ok({ question: q });
  }),
  route('DELETE', '/api/career/questions/:id', (ctx) => { ctx.repos.deleteQuestion(ctx.params.id); dataChanged(ctx, ['question']); return ok({}); }),
  route('GET', '/api/career/questions/:id/attempts', ({ repos, params }) => ok({ attempts: repos.listAttempts(params.id) })),

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
  route('POST', '/api/career/actions/review', async (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.filter((x): x is string => typeof x === 'string') : [];
    const decision = ctx.body.decision;
    if (!ids.length) return fail('ids 不能为空');
    if (decision !== 'approved' && decision !== 'rejected') return fail("decision 必须是 'approved' | 'rejected'");
    const actions = ids.map(id => ctx.repos.getAction(id)).filter((a): a is NonNullable<typeof a> => !!a && a.status === 'pending_review');
    const n = ctx.repos.reviewActions(ids, decision, 'user');
    dataChanged(ctx, ['action_queue']);
    const submits = actions.filter(a => a.kind === 'submit');
    if (decision === 'rejected') {
      // 拒绝提交：这张表的自学习计数清零，关掉这份网申的页面
      for (const a of submits) {
        const p = parseJsonObj(a.payload_json);
        resetPageTrust(ctx.repos, typeof p.formSignature === 'string' ? p.formSignature : null);
        if (a.application_id) void releasePage(a.application_id);
      }
    }
    // 批准即执行：发送投递邮件；提交交给提交执行器（立即踢一轮，不等轮询）；填表交给批量运行器
    const sent = decision === 'approved' ? await executeApprovedSendMails(intakeDeps(ctx), ids) : [];
    if (decision === 'approved' && submits.length) void kickSubmit();
    // 批准填表同样即执行：交给后台批量运行器（命令轮询几秒内接走）
    const filling = decision === 'approved' ? actions.filter(a => a.kind === 'fill_form').map(a => a.id) : [];
    if (filling.length) BatchRunner.command(ctx.repos, 'run', 'approval', filling);
    // 招呼语 / 开放题答案没有执行器（平台私信、网申开放题都只能本人操作）：批准 = 内容定稿，
    // 交给用户本人去发，动作停在 needs_user 并带上要发的文字，不能显示成「已完成」。
    const handedToUser = decision === 'approved' ? handOverUserSentActions(ctx.repos, actions) : [];
    if (handedToUser.length) dataChanged(ctx, ['action_queue']);
    return ok({ n, sent, submitting: decision === 'approved' ? submits.map(a => a.id) : [], filling, handed_to_user: handedToUser });
  }),
  // 用户在平台上亲手发完招呼语 / 填完开放题后确认：needs_user → done
  route('POST', '/api/career/actions/:id/mark-sent', (ctx) => {
    const a = ctx.repos.getAction(ctx.params.id);
    if (!a) return fail(`动作不存在：${ctx.params.id}`, 404);
    if (!USER_SENT_ACTION_KINDS.has(a.kind) || a.status !== 'needs_user') return fail(`只有等你本人发送的招呼语 / 开放题答案可以标记已发送（当前 ${a.kind} / ${a.status}）`, 409);
    const prev = parseJsonObj(a.result_json);
    ctx.repos.setActionStatus(a.id, 'done', { ...prev, handed_to_user: true, sent_by_user_at: new Date().toISOString() });
    dataChanged(ctx, ['action_queue']);
    return ok({ action: ctx.repos.getAction(a.id) });
  }),

  route('POST', '/api/career/actions/:id/confirm-submit', (ctx) => {
    const a = confirmSubmitResult(ctx.repos, ctx.params.id, ctx.body.submitted === true);
    if (!a) return fail(`提交动作不存在：${ctx.params.id}`, 404);
    dataChanged(ctx, ['action_queue', 'application', 'handoff']);
    return ok({ action: a });
  }),
  // ---------- 投递设置：auto 模式 / 自学习 ----------
  route('GET', '/api/career/apply/settings', ({ repos }) => ok({ auto_mode: getAutoMode(repos).enabled, learn_threshold: LEARN_THRESHOLD })),
  route('POST', '/api/career/apply/settings', (ctx) => {
    if (typeof ctx.body.auto_mode !== 'boolean') return fail('auto_mode 必须是布尔值');
    const s = setAutoMode(ctx.repos, ctx.body.auto_mode);
    dataChanged(ctx, ['kv']);
    return ok({ auto_mode: s.enabled, learn_threshold: LEARN_THRESHOLD });
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
  route('GET', '/api/career/exam-practices', ({ store }) => ok({ examPractices: store.listExamPractices() })),

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

  // ---------- 外部依赖配置状态（模型 Key 必需 / 搜索 Key 建议）：只回状态，不回 Key ----------
  route('GET', '/api/career/setup', () => ok({ setup: careerSetupStatus() })),

  // ---------- 对话内流程卡片（持久化；锚定在产生它的工具调用下面） ----------
  route('GET', '/api/career/cards', ({ repos, url }) => {
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) return fail('session_id 不能为空');
    return ok({ cards: repos.listChatCards(sessionId).map(toCardDto) });
  }),
  route('POST', '/api/career/cards/:id/state', (ctx) => {
    const state = ctx.body.state;
    if (state !== 'pending' && state !== 'completed' && state !== 'dismissed') return fail("state 必须是 'pending' | 'completed' | 'dismissed'");
    const row = ctx.repos.setChatCardState(ctx.params.id, state);
    if (!row) return fail(`卡片不存在：${ctx.params.id}`, 404);
    return ok({ card: toCardDto(row) });
  }),

  // ---------- 答案库 ----------
  route('GET', '/api/career/answer-bank', ({ repos, url }) => ok({ answers: repos.listAnswers({ includeArchived: url.searchParams.get('archived') === '1' }), pending_upload: repos.pendingAnswerEvents(1000).length })),
  route('POST', '/api/career/answer-bank', (ctx) => {
    const question_key = str(ctx.body.question_key); const question_text = str(ctx.body.question_text); const answer = str(ctx.body.answer);
    if (!question_key || !question_text || !answer) return fail('question_key / question_text / answer 不能为空');
    const saved = ctx.repos.saveAnswer({ question_key, question_text, answer, high_impact: !!ctx.body.high_impact, confirmed: !!ctx.body.confirmed, source: 'user' });
    if (!saved) return fail('这类问题（证件号 / 密码 / 是否使用 AI 作答等）不会存进答案库，每次请本人如实填写', 422);
    dataChanged(ctx, ['answer_bank']);
    return ok({ answer: saved });
  }),
  route('POST', '/api/career/answer-bank/:id/status', (ctx) => {
    const status = ctx.body.status;
    if (status !== 'active' && status !== 'pinned' && status !== 'archived') return fail("status 必须是 'active' | 'pinned' | 'archived'");
    try {
      const answer = ctx.repos.setAnswerStatus(ctx.params.id, status);
      dataChanged(ctx, ['answer_bank']);
      return ok({ answer });
    } catch (error) { return fail(error instanceof Error ? error.message : '更新失败', 404); }
  }),
  route('DELETE', '/api/career/answer-bank/:id', (ctx) => {
    ctx.repos.deleteAnswer(ctx.params.id);
    dataChanged(ctx, ['answer_bank']);
    return ok({});
  }),

  // ---------- 私密信息库（只有这组接口能读写明文；模型工具永远拿不到） ----------
  // 绑定账号的抓取状态（career/accounts.ts）：页面点绑定 / 重新抓取时记 requested，小芽抓完用工具回报。
  route('GET', '/api/career/accounts', (ctx) => ok({ accounts: listAccountFetch(ctx.repos) })),
  route('POST', '/api/career/accounts/:field/request', (ctx) => {
    if (!isAccountField(ctx.params.field)) return fail(`不支持的账号：${ctx.params.field}`, 404);
    const state = requestAccountFetch(ctx.repos, ctx.params.field);
    dataChanged(ctx, ['account_fetch']);
    return ok({ state });
  }),
  route('DELETE', '/api/career/accounts/:field', (ctx) => {
    if (!isAccountField(ctx.params.field)) return fail(`不支持的账号：${ctx.params.field}`, 404);
    clearAccountFetch(ctx.repos, ctx.params.field);
    dataChanged(ctx, ['account_fetch']);
    return ok({});
  }),
  route('GET', '/api/career/vault', ({ vault, core }) => ok({ status: vault.status(), items: vault.list(), profileFields: core.PROFILE_FIELDS, siteFields: core.SITE_FIELDS })),
  route('PUT', '/api/career/vault/items', (ctx) => {
    const b = ctx.body;
    if (!isVaultScope(b.scope)) return fail('scope 必须是 profile | site | experience');
    const field = str(b.field);
    if (!field) return fail('field 不能为空');
    if (typeof b.value !== 'string') return fail('value 必须是字符串（空串表示删除）');
    const ref_id = b.scope === 'site' ? ctx.core.normalizeHost(str(b.ref_id) ?? '') : str(b.ref_id);
    if (b.scope !== 'profile' && !ref_id) return fail(b.scope === 'site' ? '站点作用域需要 ref_id（网站域名）' : '经历作用域需要 ref_id（经历 id）');
    if (b.scope === 'experience' && !ctx.repos.db.get('SELECT id FROM experience WHERE id=?', [ref_id!])) return fail(`经历不存在：${ref_id}`, 404);
    try {
      const item = ctx.vault.set({
        scope: b.scope, ref_id, field, value: b.value,
        label: b.label === undefined ? undefined : strOrNull(b.label),
        sensitive: typeof b.sensitive === 'boolean' ? b.sensitive : undefined,
        policy: b.policy && typeof b.policy === 'object' ? b.policy as { autofill?: boolean } : undefined,
      });
      dataChanged(ctx, ['vault']);
      return ok({ item: item ?? null, deleted: !item });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入失败');
    }
  }),
  route('POST', '/api/career/vault/items/:id/policy', (ctx) => {
    try {
      const policy = ctx.body.policy && typeof ctx.body.policy === 'object' ? ctx.body.policy as { autofill?: boolean } : { autofill: !!ctx.body.autofill };
      const item = ctx.vault.setPolicy(ctx.params.id, policy);
      dataChanged(ctx, ['vault']);
      return ok({ item });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '更新失败', 404);
    }
  }),
  route('DELETE', '/api/career/vault/items/:id', (ctx) => {
    if (!ctx.vault.delete(ctx.params.id)) return fail('私密项不存在', 404);
    dataChanged(ctx, ['vault']);
    return ok({ deleted: true });
  }),
  route('DELETE', '/api/career/vault/sites/:host', (ctx) => {
    const n = ctx.vault.deleteSite(ctx.core.normalizeHost(ctx.params.host));
    dataChanged(ctx, ['vault']);
    return ok({ deleted: n });
  }),
  /** UI 编辑时回显明文（记访问日志 actor=ui）。此接口不暴露给任何模型工具。 */
  route('POST', '/api/career/vault/items/:id/reveal', (ctx) => {
    const value = ctx.vault.reveal(ctx.params.id, { actor: 'ui', purpose: '用户在私密信息页查看 / 编辑' });
    if (value === undefined) return fail('私密项不存在', 404);
    return ok({ value });
  }),
  route('GET', '/api/career/vault/access-log', (ctx) => ok({ log: ctx.vault.accessLog(Number(ctx.url.searchParams.get('limit') ?? 100) || 100) })),
  // ======================================================================
  // 五个面：今日 / 收件箱 / 卷宗 / 素材 / 复盘 + 邮箱 + 引导
  // ======================================================================

  // ---------- 今日 ----------
  route('GET', '/api/career/today', ({ repos }) => ok(repos.today())),
  // 「今天做过」：since 由客户端给本地零点（ISO），服务端不猜时区。
  route('GET', '/api/career/activity', ({ repos, url }) => {
    const since = url.searchParams.get('since');
    if (!since || Number.isNaN(Date.parse(since))) return ok({ entries: [] });
    return ok({ entries: repos.activitySince(new Date(since).toISOString(), 50) });
  }),
  route('GET', '/api/career/onboarding', ({ repos, store }) => {
    const claims = repos.listClaims();
    return ok({
      checklist: {
        has_experience: repos.listExperiences().length > 0,
        has_confirmed_claim: claims.some(c => c.status !== 'pending'),
        has_master_resume: store.listResumeMasters().length > 0,
        has_mail_account: repos.listMailAccounts().length > 0,
        has_job: repos.listJobs().length > 0,
        has_application: repos.listApplications().length > 0,
        has_material: repos.listMaterials().length > 0,
      },
    });
  }),

  // ---------- 收件箱 ----------
  route('GET', '/api/career/inbox', ({ repos, url }) => {
    const status = url.searchParams.get('status');
    return ok({ items: repos.listInbox(status === 'new' || status === 'processed' || status === 'dismissed' ? status : undefined) });
  }),
  route('POST', '/api/career/inbox', async (ctx) => {
    const text = str(ctx.body.text);
    if (!text) return fail('text 不能为空');
    const source = ctx.body.source;
    const result = await captureIntake(intakeDeps(ctx), { text, source: source === 'file' || source === 'url' || source === 'chat' ? source : 'paste', application_id: str(ctx.body.application_id) ?? null });
    return ok({ result });
  }),
  route('POST', '/api/career/inbox/:id/dismiss', (ctx) => {
    if (!ctx.repos.getInboxItem(ctx.params.id)) return fail(`收件箱条目不存在：${ctx.params.id}`, 404);
    const item = ctx.repos.dismissInboxItem(ctx.params.id);
    dataChanged(ctx, ['inbox_item']);
    return ok({ item });
  }),
  route('POST', '/api/career/inbox/:id/retry', async (ctx) => {
    const old = ctx.repos.getInboxItem(ctx.params.id);
    if (!old) return fail(`收件箱条目不存在：${ctx.params.id}`, 404);
    const result = await captureIntake(intakeDeps(ctx), { text: old.raw_text, source: old.source, mail_message_id: old.mail_message_id, application_id: str(ctx.body.application_id) ?? null });
    ctx.repos.dismissInboxItem(old.id);
    dataChanged(ctx, ['inbox_item']);
    return ok({ result });
  }),

  // ---------- 截止事件 ----------
  route('GET', '/api/career/deadlines', ({ repos, url }) => {
    const status = url.searchParams.get('status');
    return ok({ deadlines: repos.listDeadlines({ status: status === 'open' || status === 'done' || status === 'missed' || status === 'cancelled' || status === 'open_or_missed' ? status : undefined }) });
  }),
  route('POST', '/api/career/inbox/link', async (ctx) => {
    const url = str(ctx.body.url);
    if (!url) return fail('url 不能为空');
    try {
      const result = await captureLink(intakeDeps(ctx), { url, text: str(ctx.body.text) ?? null, application_id: str(ctx.body.application_id) ?? null });
      return ok({ result });
    } catch (error) {
      return fail(error instanceof Error ? error.message : '链接识别失败');
    }
  }),
  route('POST', '/api/career/exams', (ctx) => {
    const company_name = str(ctx.body.company_name); const due_at = isoOrUndefined(ctx.body.due_at);
    if (!company_name || !due_at) return fail('company_name 与 due_at（可解析的时间）不能为空');
    const kind = ctx.body.kind === 'assessment' ? 'assessment' : 'written_test';
    try {
      return ok(recordExam(intakeDeps(ctx), { company_name, title: strOrNull(ctx.body.title), kind, due_at, url: strOrNull(ctx.body.url), note: strOrNull(ctx.body.note) }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : '新建笔试失败');
    }
  }),
  route('POST', '/api/career/deadlines', (ctx) => {
    const title = str(ctx.body.title); const due_at = isoOrUndefined(ctx.body.due_at); const kind = str(ctx.body.kind);
    if (!title || !due_at) return fail('title 与 due_at（可解析的时间）不能为空');
    const kinds = ['assessment', 'written_test', 'interview', 'application_deadline', 'offer_reply', 'referral_expiry', 'other'] as const;
    const deadline = ctx.repos.createDeadline({ kind: (kinds as readonly string[]).includes(kind ?? '') ? kind as typeof kinds[number] : 'other', title, due_at, application_id: str(ctx.body.application_id) ?? null, job_id: str(ctx.body.job_id) ?? null, url: strOrNull(ctx.body.url), note: strOrNull(ctx.body.note), source: 'manual' });
    dataChanged(ctx, ['deadline']);
    return ok({ deadline });
  }),
  route('POST', '/api/career/deadlines/:id/status', (ctx) => {
    const status = ctx.body.status;
    if (status !== 'open' && status !== 'done' && status !== 'missed' && status !== 'cancelled') return fail('status 非法');
    try {
      const deadline = ctx.repos.setDeadlineStatus(ctx.params.id, status);
      dataChanged(ctx, ['deadline']);
      return ok({ deadline });
    } catch (error) { return fail(error instanceof Error ? error.message : '更新失败', 404); }
  }),

  // ---------- 卷宗 ----------
  route('GET', '/api/career/dossiers', ({ store }) => ok({ dossiers: store.dossierSummaries() })),
  route('GET', '/api/career/dossiers/:id', ({ store, params }) => {
    const dossier = store.dossier(params.id);
    return dossier ? ok({ dossier }) : fail(`投递不存在：${params.id}`, 404);
  }),
  route('POST', '/api/career/dossiers/:id/notes', (ctx) => {
    const content = str(ctx.body.content);
    if (!content) return fail('content 不能为空');
    const kinds = ['note', 'said', 'heard', 'contact', 'referral', 'mail'] as const;
    const kind = str(ctx.body.kind);
    try {
      const note = ctx.repos.addDossierNote({ application_id: ctx.params.id, kind: (kinds as readonly string[]).includes(kind ?? '') ? kind as typeof kinds[number] : 'note', round: strOrNull(ctx.body.round), content });
      dataChanged(ctx, ['dossier_note']);
      return ok({ note });
    } catch (error) { return fail(error instanceof Error ? error.message : '写入失败', 404); }
  }),
  route('POST', '/api/career/applications/:id/close-silent', (ctx) => {
    try {
      const application = ctx.repos.jumpTo(ctx.params.id, 'discarded', str(ctx.body.note) ?? '静默超时，主动关闭');
      ctx.repos.addDossierNote({ application_id: application.id, kind: 'note', content: '按静默超时关闭：长期无回音，不再占用注意力。' });
      dataChanged(ctx, ['application', 'application_history', 'dossier_note']);
      return ok({ application });
    } catch (error) { return fail(error instanceof Error ? error.message : '关闭失败'); }
  }),

  // ---------- 素材 ----------
  route('GET', '/api/career/materials', ({ repos, url }) => {
    const kind = url.searchParams.get('kind') ?? undefined;
    return ok({ materials: repos.listMaterials(kind ? { kind: kind as never } : {}) });
  }),
  route('GET', '/api/career/materials/uses', ({ repos, url }) => ok({ uses: repos.listMaterialUses({ application_id: url.searchParams.get('application_id') ?? undefined, company_name: url.searchParams.get('company_name') ?? undefined, material_id: url.searchParams.get('material_id') ?? undefined }) })),
  route('POST', '/api/career/materials', (ctx) => {
    const title = str(ctx.body.title); const content = str(ctx.body.content); const kind = str(ctx.body.kind) ?? 'other';
    if (!title || !content) return fail('title 与 content 不能为空');
    const material = ctx.repos.createMaterial({ kind: kind as never, title, content, question_key: strOrNull(ctx.body.question_key), length_variant: strOrNull(ctx.body.length_variant), company_scope: strOrNull(ctx.body.company_scope), confirmed: !!ctx.body.confirmed, claim_ids: Array.isArray(ctx.body.claim_ids) ? ctx.body.claim_ids.filter((x): x is string => typeof x === 'string') : [], tags: Array.isArray(ctx.body.tags) ? ctx.body.tags.filter((x): x is string => typeof x === 'string') : [] });
    dataChanged(ctx, ['material']);
    return ok({ material });
  }),
  route('PUT', '/api/career/materials/:id', (ctx) => {
    try {
      const material = ctx.repos.updateMaterial(ctx.params.id, { title: str(ctx.body.title), content: str(ctx.body.content), confirmed: typeof ctx.body.confirmed === 'boolean' ? ctx.body.confirmed : undefined, company_scope: ctx.body.company_scope === null ? null : str(ctx.body.company_scope), tags: Array.isArray(ctx.body.tags) ? ctx.body.tags.filter((x): x is string => typeof x === 'string') : undefined });
      dataChanged(ctx, ['material']);
      return ok({ material });
    } catch (error) { return fail(error instanceof Error ? error.message : '更新失败', 404); }
  }),
  route('DELETE', '/api/career/materials/:id', (ctx) => {
    if (!ctx.repos.getMaterial(ctx.params.id)) return fail(`素材不存在：${ctx.params.id}`, 404);
    ctx.repos.deleteMaterial(ctx.params.id);
    dataChanged(ctx, ['material']);
    return ok({});
  }),
  route('POST', '/api/career/materials/draft', async (ctx) => {
    const question = str(ctx.body.question); const kind = str(ctx.body.kind) ?? 'open_question';
    if (!question) return fail('question 不能为空');
    try {
      const out = await draftMaterial(intakeDeps(ctx), { kind: kind as never, question, length: str(ctx.body.length), job_id: str(ctx.body.job_id) ?? null, application_id: str(ctx.body.application_id) ?? null, company_name: str(ctx.body.company_name) ?? null, extra: str(ctx.body.extra) });
      return ok({ ...out });
    } catch (error) { return fail(error instanceof Error ? error.message : '起草失败', 503); }
  }),
  route('POST', '/api/career/materials/uses', (ctx) => {
    const context = str(ctx.body.context); const content_snapshot = str(ctx.body.content_snapshot);
    if (!context || !content_snapshot) return fail('context 与 content_snapshot 不能为空');
    const use = ctx.repos.recordMaterialUse({ material_id: str(ctx.body.material_id) ?? null, application_id: str(ctx.body.application_id) ?? null, job_id: str(ctx.body.job_id) ?? null, company_name: str(ctx.body.company_name) ?? null, context, content_snapshot });
    dataChanged(ctx, ['material_use']);
    return ok({ use });
  }),

  // ---------- 复盘 ----------
  route('GET', '/api/career/review', ({ repos }) => ok({ funnel: repos.funnel(), reviews: repos.listWeeklyReviews(12) })),
  route('POST', '/api/career/review/weekly', async (ctx) => {
    try {
      const out = await generateWeeklyReview(intakeDeps(ctx), { week_start: str(ctx.body.week_start), user_note: str(ctx.body.user_note) });
      return ok({ review: out.review, output: out.output });
    } catch (error) { return fail(error instanceof Error ? error.message : '复盘失败', 503); }
  }),

  // ---------- 邮箱 ----------
  route('GET', '/api/career/mail/accounts', ({ repos }) => ok({ accounts: repos.listMailAccounts(), presets: MAIL_PRESETS })),
  route('POST', '/api/career/mail/accounts', async (ctx) => {
    const address = str(ctx.body.address)?.toLowerCase(); const password = str(ctx.body.password);
    if (!address || !address.includes('@')) return fail('address 需要是邮箱地址');
    const providerInput = str(ctx.body.provider);
    const provider = (providerInput && ['qq', '163', '126', 'gmail', 'outlook', 'imap'].includes(providerInput) ? providerInput : detectProvider(address)) as import('@career/core').MailProvider;
    const preset = presetFor(provider);
    const imap_host = str(ctx.body.imap_host) ?? preset?.imap_host; const smtp_host = str(ctx.body.smtp_host) ?? preset?.smtp_host;
    if (!imap_host || !smtp_host) return fail('该邮箱域名没有预设，请填写 imap_host 与 smtp_host');
    const existing = ctx.repos.listMailAccounts().find(a => a.address === address);
    if (!password && !existing) return fail('首次绑定需要授权码 / 应用密码');
    const account = ctx.repos.upsertMailAccount({ provider, address, display_name: strOrNull(ctx.body.display_name), imap_host, imap_port: typeof ctx.body.imap_port === 'number' ? ctx.body.imap_port : preset?.imap_port, smtp_host, smtp_port: typeof ctx.body.smtp_port === 'number' ? ctx.body.smtp_port : preset?.smtp_port });
    if (password) setMailPassword(account.id, password);
    dataChanged(ctx, ['mail_account']);
    // 立即验证一次（拉最近邮件），把状态写回账号
    const verify = ctx.body.verify === false ? null : await syncMailAccount(intakeDeps(ctx), account);
    return ok({ account: ctx.repos.getMailAccount(account.id), verify });
  }),
  // 一键连接：产品浏览器打开官方页面，扫码登录后自动读授权码、验证、绑定（mail/connect.ts）
  route('POST', '/api/career/mail/connect', (ctx) => {
    const provider = ctx.body.provider;
    if (!isConnectProvider(provider)) return fail(`暂不支持一键连接：${String(provider)}`);
    const preset = presetFor(provider)!;
    const injected = ctx.deps.mailConnect ?? {};
    const deps: ConnectDeps = {
      withPage: injected.withPage ?? (async fn => {
        const { withMailConnectPage } = await import('../career/batch-service');
        await withMailConnectPage(page => fn(fromPlaywrightPage(page)));
      }),
      verifyLogin: injected.verifyLogin ?? ((_p, address, code) => verifyImapLogin(preset.imap_host, preset.imap_port, address, code)),
      bind: async (p, address, code) => {
        const account = ctx.repos.upsertMailAccount({ provider: p, address, imap_host: preset.imap_host, imap_port: preset.imap_port, smtp_host: preset.smtp_host, smtp_port: preset.smtp_port });
        setMailPassword(account.id, code);
        dataChanged(ctx, ['mail_account']);
        const verify = await syncMailAccount(intakeDeps(ctx), account);
        return { account_id: account.id, summary: verify.error ? `已连接，首次同步失败：${verify.error}` : `拉到 ${verify.fetched} 封，其中 ${verify.job_related} 封与求职相关` };
      },
      ...(injected.tickMs ? { tickMs: injected.tickMs } : {}),
      ...(injected.sleep ? { sleep: injected.sleep } : {}),
    };
    return ok({ session: startMailConnect(deps, provider, { address: str(ctx.body.address) }), label: RECIPES[provider].label });
  }),
  route('GET', '/api/career/mail/connect/:id', ({ params }) => {
    const session = getMailConnect(params.id);
    return session ? ok({ session }) : fail('连接已结束或不存在', 404);
  }),
  route('POST', '/api/career/mail/connect/:id/address', (ctx) => {
    const address = str(ctx.body.address)?.toLowerCase();
    if (!address || !address.includes('@')) return fail('address 需要是邮箱地址');
    const session = provideConnectAddress(ctx.params.id, address);
    return session ? ok({ session }) : fail('连接已结束或不存在', 404);
  }),
  route('DELETE', '/api/career/mail/connect/:id', ({ params }) => {
    const session = cancelMailConnect(params.id);
    return session ? ok({ session }) : fail('连接已结束或不存在', 404);
  }),
  route('DELETE', '/api/career/mail/accounts/:id', (ctx) => {
    if (!ctx.repos.getMailAccount(ctx.params.id)) return fail(`邮箱账号不存在：${ctx.params.id}`, 404);
    ctx.repos.deleteMailAccount(ctx.params.id);
    deleteMailPassword(ctx.params.id);
    dataChanged(ctx, ['mail_account']);
    return ok({});
  }),
  route('POST', '/api/career/mail/sync', async (ctx) => {
    const accountId = str(ctx.body.account_id);
    const deps = intakeDeps(ctx);
    if (accountId) {
      const account = ctx.repos.getMailAccount(accountId);
      if (!account) return fail(`邮箱账号不存在：${accountId}`, 404);
      return ok({ results: [await syncMailAccount(deps, account)] });
    }
    return ok({ results: await syncAllMailAccounts(deps) });
  }),
  route('GET', '/api/career/mail/messages', ({ repos, url }) => {
    const direction = url.searchParams.get('direction');
    const relevance = url.searchParams.get('relevance');
    return ok({ messages: repos.listMailMessages({ application_id: url.searchParams.get('application_id') ?? undefined, account_id: url.searchParams.get('account_id') ?? undefined, direction: direction === 'in' || direction === 'out' ? direction : undefined, relevance: relevance === 'job' || relevance === 'ignored' || relevance === 'unknown' ? relevance : undefined, limit: Number(url.searchParams.get('limit') ?? 100) || 100 }) });
  }),
];

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return '未命名岗位'; }
}

/** 没有执行器、批准后只能由用户本人去平台发送的动作。 */
const USER_SENT_ACTION_KINDS: ReadonlySet<string> = new Set(['send_greeting', 'answer_open_q']);
const USER_SENT_NOTE: Record<string, string> = {
  send_greeting: '已批准，招呼语需要你本人在平台发送',
  answer_open_q: '已批准，开放题答案需要你本人在网申页面填写提交',
};

/** 批准后的招呼语 / 开放题答案：approved → needs_user，result 里带要发的文字与说明。返回交给用户的条目。 */
function handOverUserSentActions(repos: Repos, reviewed: ReadonlyArray<{ id: string; kind: string }>): Array<{ id: string; kind: string; text: string | null; message: string }> {
  const out: Array<{ id: string; kind: string; text: string | null; message: string }> = [];
  for (const r of reviewed) {
    if (!USER_SENT_ACTION_KINDS.has(r.kind)) continue;
    const a = repos.getAction(r.id);
    if (!a || a.status !== 'approved') continue;
    const p = parseJsonObj(a.payload_json);
    const text = [p.text, p.answer, p.greeting].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null;
    const message = USER_SENT_NOTE[a.kind];
    repos.setActionStatus(a.id, 'needs_user', { handed_to_user: true, message: text ? `${message}：${text}` : message, text, question: typeof p.question === 'string' ? p.question : undefined });
    out.push({ id: a.id, kind: a.kind, text, message });
  }
  return out;
}

/** 入口：非 `/api/career/` 或浏览器子路径返回 null。 */
function toCardDto(row: import('@career/core').ChatCardRow) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data_json) as Record<string, unknown>; } catch { /* 坏数据按空处理 */ }
  return { id: row.id, kind: row.kind, title: row.title, data, createdAt: row.created_at, sessionId: row.session_id, toolUseId: row.tool_use_id, state: row.state };
}

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
    let vault: Vault;
    try {
      core = await loadCore();
      repos = deps.repos ?? await getRepos();
      vault = deps.vault ?? (deps.repos ? await vaultForRepos(deps.repos) : await getVault());
    } catch (error) {
      return fail(error instanceof Error ? error.message : '求职数据层不可用', 503);
    }
    const ctx: Ctx = {
      request, url: new URL(request.url), params, repos, core, vault, store: new CareerStore(repos, core),
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
