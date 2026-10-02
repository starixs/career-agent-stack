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
import { captureIntake, type IntakeDeps } from '../career/intake';
import { deleteMailPassword, setMailPassword } from '../career/mail/credentials';
import { MAIL_PRESETS, detectProvider, presetFor } from '../career/mail/providers';
import { executeApprovedSendMails } from '../career/mail/send';
import { syncAllMailAccounts, syncMailAccount } from '../career/mail/sync';
import { draftMaterial } from '../career/materials';
import { generateWeeklyReview } from '../career/review';
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

/** 路由 → 共享服务（收件箱 / 邮箱 / 复盘 / 素材）的依赖；llm: undefined → 进程 ShellLLM，null → 不调模型。 */
function intakeDeps(ctx: Ctx): IntakeDeps {
  let llm: IntakeDeps['llm'] = null;
  if (ctx.deps.llm === undefined) { try { llm = getShellLLM(); } catch { llm = null; } } else llm = ctx.deps.llm;
  return { repos: ctx.repos, core: ctx.core, llm, broadcast: ctx.deps.broadcast, sessionId: ctx.deps.sessionId };
}
const isoOrUndefined = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

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
  route('POST', '/api/career/actions/review', async (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.filter((x): x is string => typeof x === 'string') : [];
    const decision = ctx.body.decision;
    if (!ids.length) return fail('ids 不能为空');
    if (decision !== 'approved' && decision !== 'rejected') return fail("decision 必须是 'approved' | 'rejected'");
    const n = ctx.repos.reviewActions(ids, decision);
    dataChanged(ctx, ['action_queue']);
    // 批准即执行：发送投递邮件（提交与发送永远过人，这里已经过人）。
    const sent = decision === 'approved' ? await executeApprovedSendMails(intakeDeps(ctx), ids) : [];
    return ok({ n, sent });
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

  // ======================================================================
  // 五个面：今日 / 收件箱 / 卷宗 / 素材 / 复盘 + 邮箱 + 引导
  // ======================================================================

  // ---------- 今日 ----------
  route('GET', '/api/career/today', ({ repos }) => ok(repos.today())),
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
