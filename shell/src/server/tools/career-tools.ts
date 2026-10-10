import { AsyncLocalStorage } from 'async_hooks';
// 求职常驻工具集 `career`（docs/API.md 工具表）。Pattern 1 常驻注入，用户不可关。
//
// 工具只做两类事：读写数据层（@career/core Repos / CareerStore）；把需要执行的动作入队或触发 run。
// 模型类工具（jd_parse / resume_tailor / interview_* / direction_explore / gap_plan / offer_compare /
// greeting_compose / job_evaluate / company_research）通过 app/skills/<name> 的提示词 + ShellLLM 调模型。
// submit / send_greeting / answer_open_q 只能入待审队列（Repos.enqueueAction 已强制）。
//
// SDK + zod 只在 createCareerServer() 内动态 import（builtin-mcp-registry 的 lazy 约束）。
import { existsSync } from 'fs';
import { basename } from 'path';
import type { Repos, LLM, Job, JdParsed, Claim, Vault, ActionQueueItem, Task } from '@career/core';

import { loadCore } from '../career/core-module';
import { getRepos, careerExportsDir } from '../career/db';
import { DomainUnavailableError, loadBridges, loadResume } from '../career/domain';
import { exportResumeFile, isExportFormat, EXPORT_FORMATS } from '../career/export';
import { captureIntake, focus as focusPanel, parseAndStoreJd as parseAndStoreJdShared, type IntakeDeps } from '../career/intake';
import { getShellLLM } from '../career/llm';
import { MAIL_PRESETS } from '../career/mail/providers';
import { syncAllMailAccounts, syncMailAccount } from '../career/mail/sync';
import { draftMaterial } from '../career/materials';
import { generateWeeklyReview } from '../career/review';
import { getRunRegistry, type RunRegistry } from '../career/runs';
import { getSearchProvider, type CareerSearchProvider } from '../career/search';
import { loadSkillPrompt } from '../career/skills';
import { CareerStore, DIRECTION_STATUSES } from '../career/store';
import { SEARCH_NOT_CONFIGURED_MESSAGE } from '../career/setup';
import { applyJsonPatch, confirmTailorProposal, readTailorProposal } from '../career/tailor';
import { getVault, vaultForRepos } from '../career/vault';
import { persistDriveOutcome } from '../career/drive-outcome';
import { freezePacket, packetResumeFile, pickResumeForJob } from '../career/packets';
import { acquireBrowserCapability } from '../browser-host/capability-client';
import { broadcast as sseBroadcast } from '../sse';
import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface CareerToolDeps {
  repos?: Repos;
  /** 私密信息库：所有工具结果回传前统一脱敏；缺省按 repos 的连接构造。 */
  vault?: Vault;
  llm?: LLM;
  broadcast?: (event: string, data: unknown) => void;
  sessionId?: () => string;
  runs?: RunRegistry;
  search?: () => Promise<CareerSearchProvider | null>;
  exportsDir?: string;
  /** 通过 Browser capability 调 Global 浏览器路由；测试注入。 */
  browserRun?: (body: Record<string, unknown>, onEvent: (ev: Record<string, unknown>) => void) => Promise<void>;
  /** 简历 schema 校验；缺省惰性加载 @career/resume（测试可注入只含 parseResume 的轻量实现）。 */
  resumeModule?: () => Promise<Pick<typeof import('@career/resume'), 'parseResume'>>;
  /** false：导出 PDF 不用简历工作台模板（测试用）。 */
  studioExport?: boolean;
}

const sessionCtx = { sessionId: 'default' };

/** builtin-mcp-registry 的 configure 钩子：冻结当前 Session id 供事件携带。 */
export function configureCareerTools(_env: Record<string, string>, ctx: { sessionId: string }): void {
  sessionCtx.sessionId = ctx.sessionId || 'default';
}

// ============= 小工具 =============

const MAX_RESULT_CHARS = 60_000;

function text(data: unknown): CallToolResult {
  let body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (body.length > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}\n…（结果过长已截断）`;
  return { content: [{ type: 'text', text: body }] };
}
function err(message: unknown): CallToolResult {
  const msg = message instanceof Error ? message.message : String(message);
  return { content: [{ type: 'text', text: msg }], isError: true };
}
function parseJson<T = unknown>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export { applyJsonPatch } from '../career/tailor';

// ============= 工具调用上下文（卡片锚点） =============
const toolCallContext = new AsyncLocalStorage<{ toolUseId: string | null }>();
/** SDK 的 handler extra 未声明类型；CLI 在 tools/call 的 _meta 里带 tool_use id。 */
export function toolUseIdFrom(extra: unknown): string | null {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const id = meta?.['claudecode/toolUseId'];
  return typeof id === 'string' && id ? id : null;
}

// ============= Server =============

export async function createCareerServer(deps: CareerToolDeps = {}) {
  const { createSdkMcpServer, tool: sdkTool } = await import('@anthropic-ai/claude-agent-sdk');
  /**
   * 包一层工具注册：Claude Code CLI 调 MCP 工具时在 `_meta['claudecode/toolUseId']` 带上本次 tool_use id，
   * 放进 AsyncLocalStorage，card() 据此把卡片锚定到产生它的那次工具调用（渲染在那条回复下面）。
   */
  const tool = ((name: string, description: string, schema: unknown, handler: (args: never, extra: unknown) => Promise<CallToolResult>) =>
    (sdkTool as (...a: unknown[]) => unknown)(name, description, schema, (args: never, extra: unknown) =>
      toolCallContext.run({ toolUseId: toolUseIdFrom(extra) }, () => handler(args, extra)))) as unknown as typeof sdkTool;
  const { z } = await import('zod/v4');
  // 数据层：core 惰性加载；Repos 在 server 构建时打开一次（Session 内共享）。
  const core = await loadCore();
  const sharedRepos = deps.repos ?? await getRepos();
  const sharedVault = deps.vault ?? (deps.repos ? await vaultForRepos(deps.repos) : await getVault());

  const repos = () => sharedRepos;
  const vault = () => sharedVault;
  /** 入口 hook：任何工具结果回传模型前，把私密库里的明文换回 {{vault:...}} 占位符。 */
  const redactResult = (res: CallToolResult): CallToolResult => ({ ...res, content: res.content.map(c => (c.type === 'text' ? { ...c, text: sharedVault.redact(c.text) } : c)) });
  const store = () => new CareerStore(sharedRepos, core);
  const llm = () => deps.llm ?? getShellLLM();
  const broadcast = deps.broadcast ?? sseBroadcast;
  const sessionId = deps.sessionId ?? (() => sessionCtx.sessionId);
  const runs = () => deps.runs ?? getRunRegistry({ broadcast, sessionId });
  const search = deps.search ?? getSearchProvider;
  const exportsDir = () => deps.exportsDir ?? careerExportsDir();

  const progress = (phase: string, message: string, extra: Record<string, unknown> = {}) =>
    broadcast('career:progress', { sessionId: sessionId(), phase, message, ...extra });
  const changed = (...tables: string[]) => broadcast('career:data-changed', { sessionId: sessionId(), tables });
  const review = (actionIds: string[], kind: string, summary: string) =>
    broadcast('career:review', { sessionId: sessionId(), actionIds, kind, summary });
  /**
   * 对话内流程卡片：把"要用户动手的一步"直接放进对话（填资料 / 回答 / 确认），用户在卡片里完成，
   * 值走产品自己的接口落库（私密信息进私密库），不经过模型上下文。同 id 的卡片会被覆盖。
   */
  const card = (id: string, kind: string, title: string, data: Record<string, unknown>) => {
    const sid = sessionId() ?? null;
    const toolUseId = toolCallContext.getStore()?.toolUseId ?? null;
    // 持久化：重载后按会话读回，已完成 / 已忽略的折叠成一行；重新推出时回到 pending
    let createdAt = new Date().toISOString();
    try { createdAt = repos().upsertChatCard({ id, session_id: sid, tool_use_id: toolUseId, kind, title, data }).created_at; } catch { /* 落库失败也照常推送 */ }
    broadcast('career:card', { sessionId: sid, card: { id, kind, title, data, createdAt, sessionId: sid, toolUseId, state: 'pending' } });
  };
  const profileFieldSet = new Set<string>(core.PROFILE_FIELDS.map(f => f.field));
  /** 填表需要用户补充 / 确认的项 → needs_user / drafts 卡片。资料类字段写私密库，其余写答案库。 */
  const emitDriveCards = (actionId: string, summary: Record<string, unknown> | undefined) => {
    const asPlans = (v: unknown) => (Array.isArray(v) ? v as Array<{ fieldId?: string; label?: string; key?: string; note?: string; value?: string }> : []);
    const needs = asPlans(summary?.needsUser).filter(p => typeof p.label === 'string' && p.label);
    const drafts = asPlans(summary?.drafts).filter(p => typeof p.label === 'string' && p.label);
    if (needs.length) {
      card(`needs_user:${actionId}`, 'needs_user', `网申表里有 ${needs.length} 项需要你来填`, {
        action_id: actionId,
        items: needs.slice(0, 20).map(p => {
          const def = p.key && profileFieldSet.has(p.key) ? core.PROFILE_FIELDS.find(f => f.field === p.key) : undefined;
          return { label: p.label, note: p.note ?? null, vault_field: def?.field ?? null, sensitive: def?.sensitive ?? false };
        }),
      });
    }
    if (drafts.length) {
      card(`drafts:${actionId}`, 'drafts', `${drafts.length} 道开放题已起草，确认后再填`, {
        action_id: actionId,
        items: drafts.slice(0, 10).map(p => ({ label: p.label, value: p.value ?? '', note: p.note ?? null })),
      });
    }
  };

  /** 技能提示词 + 模型 → JSON。 */
  async function askSkill<T = unknown>(skill: string, user: string, opts: { refs?: string[]; temperature?: number; json?: boolean } = {}): Promise<T> {
    const system = await loadSkillPrompt(skill, opts.refs ?? []);
    progress(skill, `正在调用模型（${skill}）`);
    const res = await llm().complete({ system, messages: [{ role: 'user', content: user }], json: opts.json ?? true, temperature: opts.temperature ?? 0.3 });
    return (opts.json ?? true) ? core.extractJson<T>(res.text) : (res.text as unknown as T);
  }

  const requireJob = (jobId: string): Job => {
    const job = repos().getJob(jobId);
    if (!job) throw new Error(`岗位不存在：${jobId}`);
    return job;
  };
  const jdOf = (job: Job): JdParsed | undefined => parseJson<JdParsed>(job.jd_parsed_json);
  const confirmedClaims = (): Claim[] => repos().listClaims().filter(c => c.status !== 'pending');
  const experienceDigest = (onlyConfirmed = true): string => repos().experienceTree().map(e => {
    const claims = e.claims.filter(c => !onlyConfirmed || c.status !== 'pending');
    return `## ${e.title}${e.role ? `（${e.role}）` : ''}${e.org ? ` @ ${e.org}` : ''} ${e.start_date ?? '?'}~${e.end_date ?? '至今'}\n${claims.map(c => `- [${c.id}][${c.status}/${c.attribution}] ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '- （无已确认主张）'}`;
  }).join('\n\n') || '（经历库为空）';
  const jobDigest = (job: Job): string => `公司：${job.company_name ?? '未知'}\n岗位：${job.title}\n地点：${job.location ?? '未知'}\n${job.jd_parsed_json ? `JdParsed：${job.jd_parsed_json}` : `JD 原文：${job.jd_raw ?? '（无）'}`}`;
  const prefs = (): unknown => repos().kvGet('preferences') ?? {};

  /** 共享服务（收件箱 / 复盘 / 素材 / 邮箱）的依赖。 */
  const intakeDeps = (): IntakeDeps => ({ repos: repos(), core, llm: llm(), broadcast, sessionId });
  const focus = (hint: Parameters<typeof focusPanel>[1]) => focusPanel({ broadcast, sessionId }, hint);
  const parseAndStoreJd = (input: { jd_raw?: string; url?: string; job_id?: string; company_name?: string; title?: string; source_platform?: string }): Promise<{ job: Job; parsed: JdParsed }> =>
    parseAndStoreJdShared(intakeDeps(), input);

  /** 通过 Browser capability 调 Global `/api/career/browser/run`（NDJSON 流）。 */
  const browserRun = deps.browserRun ?? (async (body, onEvent) => {
    const parentSignal = getCurrentTurnSignal(sessionId());
    const cap = await acquireBrowserCapability(parentSignal);
    // capability.url 指向 Global 的 `/mcp/playwright`，career 路由挂在同一 origin 下（直接拼会 404）
    const origin = new URL(cap.url).origin;
    // 填表 run 可能持续数分钟（NDJSON 流）；跟随当前 turn 的 abort，并给 10 分钟上限。
    const response = await cancellableFetch(
      `${origin}/api/career/browser/run`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cap.token}` }, body: JSON.stringify(body) },
      { parentSignal, timeoutMs: 10 * 60_000 },
    );
    if (!response.ok || !response.body) throw new Error(`浏览器 run 请求失败（HTTP ${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line) as Record<string, unknown>); } catch { /* 跳过非 JSON 行 */ }
      }
    }
    if (buf.trim()) { try { onEvent(JSON.parse(buf) as Record<string, unknown>); } catch { /* ignore */ } }
  });

  const wrap = (fn: () => Promise<CallToolResult> | CallToolResult) => async (): Promise<CallToolResult> => {
    try { return redactResult(await fn()); } catch (error) {
      if (error instanceof DomainUnavailableError) return err(`${error.message}（该能力依赖的领域库尚未就绪）`);
      return redactResult(err(error));
    }
  };
  /** 简历导出：渲染前解占位符（只在 Node 侧），落库 JSON 不变。 */
  const exportWithVault = (resumeId: string, format: 'pdf' | 'docx' | 'png') =>
    exportResumeFile(store(), resumeId, format, exportsDir(), undefined, schema => vault().resolveDeep(schema, { actor: 'resume_export', purpose: `导出简历 ${resumeId} ${format}` }), deps.studioExport === false ? null : { repos: repos() });
  /** 投递用的简历文件：定制版已有 PDF 就复用，否则现导（失败不阻塞填表，只是不上传附件）。 */
  const resumeFileFor = async (resumeId: unknown): Promise<string | undefined> => {
    if (typeof resumeId !== 'string' || !resumeId) return undefined;
    const found = store().getResume(resumeId);
    if (!found) return undefined;
    if (found.kind === 'tailored' && found.row.export_pdf && existsSync(found.row.export_pdf)) return found.row.export_pdf;
    try { return await exportWithVault(resumeId, 'pdf'); } catch { return undefined; }
  };

  const packetDeps = () => ({ repos: repos(), store: store(), exportPdf: (id: string) => exportWithVault(id, 'pdf'), exportsDir: exportsDir() });

  const strengthEnum = z.enum(['nudge', 'keywords', 'full']);

  /** 简历 JSON 过一遍 schema（补默认值、拒绝不合法结构）；领域库未就绪时原样返回，避免阻塞起草。 */
  const normalizeResume = async (input: unknown): Promise<unknown> => {
    try {
      const mod = await (deps.resumeModule ?? loadResume)();
      return mod.parseResume(input ?? {});
    } catch (error) {
      if (error instanceof DomainUnavailableError) return input ?? {};
      throw error;
    }
  };
  /** 没传 master_id 时：只有一份主简历就用它；多份让模型先问用户；没有则提示先创建。 */
  const resolveMaster = (masterId?: string) => {
    const s = store();
    if (masterId) {
      const found = s.getResume(masterId);
      if (!found || found.kind !== 'master') throw new Error(`主简历不存在：${masterId}`);
      return found.row;
    }
    const masters = s.listResumeMasters();
    if (masters.length === 0) throw new Error('还没有主简历。请先调用 resume_master_create 从经历库起草一份主简历（或让用户在「简历」页新建），再做定制。');
    if (masters.length > 1) throw new Error(`有 ${masters.length} 份主简历，请先调用 resume_list 并让用户选择 master_id：${masters.map(m => `${m.id}（${m.name}）`).join('、')}`);
    return masters[0];
  };
  const resumeSummary = (row: { id: string; name?: string; direction?: string | null; schema_json: string; updated_at: string }) => {
    const schema = parseJson<{ basics?: { name?: string; objective?: string }; experience?: unknown[]; projects?: unknown[]; education?: unknown[] }>(row.schema_json) ?? {};
    return { id: row.id, name: row.name, direction: row.direction ?? null, candidate: schema.basics?.name ?? '', objective: schema.basics?.objective ?? '', education: schema.education?.length ?? 0, experience: schema.experience?.length ?? 0, projects: schema.projects?.length ?? 0, updated_at: row.updated_at };
  };
  const basicsSchema = z.object({
    name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), city: z.string().optional(),
    target_cities: z.array(z.string()).optional(), expected_salary: z.string().optional(), political_status: z.string().optional(),
    objective: z.string().optional().describe('求职意向'), availability: z.string().optional().describe('到岗时间'),
    links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  });
  const educationSchema = z.object({
    school: z.string(), degree: z.string().optional(), major: z.string().optional(), start: z.string().optional().describe('如 2021.09'), end: z.string().optional().describe('如 2025.06 / 至今'),
    gpa: z.string().optional(), courses: z.array(z.string()).optional(),
  });

  /**
   * apply_run / apply_continue 共用：驱动一次 drive，并按 NDJSON 结果更新动作 / 任务 / 接管 / 阶段。
   * 浏览器路由只发 progress / page / result / error 四种行；接管体现在 result.status === 'handoff'，
   * 错误行（501 引擎未就绪 / 400 缺资料 / 401 / 409）一律按失败处理，不再被误记成"已填好"。
   */
  async function runDrive(action: ActionQueueItem, mode: 'start' | 'continue'): Promise<CallToolResult> {
    const r = repos();
    const payload = parseJson<Record<string, unknown>>(action.payload_json) ?? {};
    const runId = `run_${action.id}`;
    const registry = runs();
    let task = mode === 'continue' ? r.db.get<Task>('SELECT * FROM task WHERE kind=? AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1', ['apply', `%"action_id":"${action.id}"%`]) : undefined;
    if (!task) task = r.createTask({ title: `网申填表 ${String(payload.job_id ?? '')}`, kind: 'apply', sessionId: sessionId(), payload: { ...payload, action_id: action.id } });
    const taskId = task.id;
    r.updateTask(taskId, { status: 'running' });
    if (mode === 'continue') {
      for (const h of r.openHandoffs()) if (h.action_id === action.id) r.closeHandoff(h.id, 'apply_continue');
      r.setActionStatus(action.id, 'executing');
    } else {
      // 认领：approved → executing 原子切换并核对批准时的内容哈希；后台批量已经拿走 / 批准后内容变了都会失败
      const claim = r.claimAction(action.id);
      if (!claim.ok) {
        r.updateTask(taskId, { status: 'failed' });
        changed('task', 'action_queue');
        return err(claim.reason === 'content_changed' ? '这份网申在批准之后内容有变化，已退回待审核，请让用户重新确认后再执行' : `动作已不是待执行状态（${claim.action?.status ?? '不存在'}），可能后台批量投递正在处理它`);
      }
    }
    if (action.application_id) { try { r.transition(action.application_id, 'pending', mode === 'start' ? 'apply_run 开始' : 'apply_continue 继续'); } catch { /* 阶段已在执行态 */ } }
    changed('task', 'action_queue', 'application', 'handoff');
    const existing = registry.get(runId);
    if (!existing) registry.start(runId, { taskId, actionId: action.id, url: typeof payload.url === 'string' ? payload.url : undefined });
    else if (existing.state !== 'running') {
      try {
        if (existing.state === 'paused' || existing.state === 'human_active') registry.transition(runId, 'resuming');
        registry.transition(runId, 'running', { handoffId: undefined });
      } catch { registry.finish(runId); registry.start(runId, { taskId, actionId: action.id }); }
    }
    const failRun = (message: string, summary?: Record<string, unknown>, kind: 'blocked' | 'failed' = 'failed') => {
      r.setActionStatus(action.id, 'failed', { error: message, ...(summary ? { summary } : {}) });
      r.updateTask(taskId, { status: 'failed' });
      registry.finish(runId);
      if (action.application_id) { try { r.transition(action.application_id, 'blocked', message, { blocker_reason: message, next_action: '查看阻塞原因后重试' }); } catch { /* ignore */ } }
      changed('task', 'action_queue', 'application');
      return err(`填表${kind === 'blocked' ? '被阻塞' : '执行失败'}：${message}`);
    };
    const events: Array<Record<string, unknown>> = [];
    try {
      // 填表资料（姓名 / 手机 / 邮箱 / 证件号…）由浏览器路由在 Node 侧从私密库组装，这里不传、也看不到明文；
      // 返回的事件已脱敏（明文 → {{vault:...}} 占位符）。continue 不传 url：从当前页继续。
      const file = await packetResumeFile(r, payload, resumeFileFor);
      if (file.error) return failRun(file.error);
      const resumePath = file.path;
      // 续跑：上次 needs_user 的标签交给引擎，用户在接管期间自己填好的值会被学进答案库
      const prevSummary = mode === 'continue' ? parseJson<{ needsUser?: Array<{ label?: string }> }>(action.result_json) : undefined;
      const learnFrom = (prevSummary?.needsUser ?? []).map(p => p.label).filter((l): l is string => typeof l === 'string' && !!l);
      await browserRun({ op: 'drive', runId, actionId: action.id, applicationId: action.application_id, payload, ...(mode === 'start' && typeof payload.url === 'string' ? { url: payload.url } : {}), ...(resumePath ? { resumePath } : {}), ...(learnFrom.length ? { learnFrom } : {}) }, (ev) => {
        events.push(ev);
        if (ev.type === 'progress') progress('apply_run', String(ev.message ?? ''), { runId, taskId, progress: ev.progress });
      });
    } catch (error) {
      return failRun(error instanceof Error ? error.message : String(error));
    }
    if (events.some(e => e.type === 'error' && e.code === 'BROWSER_BUSY')) {
      // 后台批量正在用浏览器：动作放回 approved（批准仍有效），不记失败
      if (mode === 'start') r.requeueAction(action.id); else r.setActionStatus(action.id, 'needs_user');
      r.updateTask(taskId, { status: 'queued' });
      registry.finish(runId);
      changed('task', 'action_queue');
      return err('后台批量投递正在使用浏览器填另一份网申。这份已放回队列（批准仍有效）：可以等批量顺带处理，或让用户先暂停批量再执行。');
    }
    const outcome = persistDriveOutcome({ repos: r, action, taskId, events, changed, review });
    if (outcome.kind !== 'failed') emitDriveCards(action.id, outcome.summary);
    // 卡在登录页且私密库里没有这个站的账号：对话里给一张「保存登录账号」卡，存好后产品在登录页代填（点登录仍由用户）
    if (outcome.kind === 'handoff' && outcome.reason === 'login' && outcome.finalUrl) {
      const host = core.normalizeHost(outcome.finalUrl);
      const site = vault().status().sites.find(x => x.host === host);
      if (host && !site?.hasPassword) card(`site_login:${host}`, 'site_login', `保存 ${host} 的登录账号`, { host, action_id: action.id, has_username: !!site?.hasUsername });
    }
    if (outcome.kind === 'failed') {
      registry.finish(runId);
      return err(`填表${outcome.blocked ? '被阻塞' : '执行失败'}：${outcome.message}`);
    }
    if (outcome.kind === 'handoff') {
      try { registry.pause(runId, outcome.reason, { handoffId: outcome.handoffId, url: outcome.finalUrl, message: outcome.userAction ?? outcome.message }); } catch { /* 已是暂停态 */ }
      return text({ runId, taskId, state: 'paused', handoffId: outcome.handoffId, reason: outcome.reason, userAction: outcome.userAction, summary: outcome.summary, note: '已暂停：请把 userAction 原话告诉用户；用户在浏览器里处理完并点"交回"后，调用 apply_continue(action_id) 从当前页继续。' });
    }
    registry.finish(runId);
    return text({ runId, taskId, state: 'done', submitActionId: outcome.submitActionId, autoApproved: outcome.autoApproved ?? null, decision: outcome.decision, summary: outcome.summary,
      note: outcome.autoApproved
        ? `表单已填好，${outcome.decision}；产品会在几秒内自动点提交，结果会更新到这份投递。`
        : `表单已填好但未提交；提交动作已进待审核队列（${outcome.decision ?? '需要你确认'}）。用户看过审阅清单批准后，产品替用户点提交。${outcome.pending > 0 ? `有 ${outcome.pending} 项需要用户补充 / 确认（见 needsUser / drafts / mismatches）。` : ''}` });
  }

  return createSdkMcpServer({
    name: 'career',
    version: '1.0.0',
    instructions: '求职助理的数据与执行工具。读写一律走这些工具；submit / send_greeting / answer_open_q / send_mail 进入待审核队列，由用户批准后执行（网申提交例外：用户开了 auto 模式，或同一张表已自学习免审时会直接提交）。',
    tools: [
      // ---------- 概览 / 经历库 ----------
      tool('career_overview', '返回看板三问题（今天必须做什么 / 哪里卡住 / 漏斗分布）+ 待审数 + 进行中的任务 + 未关闭的接管。', {}, wrap(() => text(store().overview()))),

      tool('ui_open', '在产品里替用户打开界面：resume_editor = 在聊天旁打开简历在线编辑器（可传 resume_id 定位到某一版，用户可直接改、预览、导出）；live = 在聊天旁打开浏览器现场；其余打开对应一级面板（today / inbox / dossier / material / review / guide / vault），可带对象 id 定位。用户说"打开 / 调出 / 我想自己改 / 让我看看"时直接调用，不要让用户自己去找入口。', {
        target: z.enum(['resume_editor', 'live', 'today', 'inbox', 'dossier', 'material', 'review', 'guide', 'vault']),
        resume_id: z.string().optional().describe('resume_editor：要打开的简历（主简历或定制版）；缺省打开唯一 / 最近的主简历'),
        application_id: z.string().optional(), job_id: z.string().optional(), id: z.string().optional().describe('面板内要定位的对象 id'),
      }, async (args) => wrap(() => {
        if (args.target === 'resume_editor') {
          let resumeId = args.resume_id ?? null;
          if (resumeId && !store().getResume(resumeId)) return err(`简历不存在：${resumeId}；先用 resume_list 查 id`);
          if (!resumeId) { try { resumeId = resolveMaster().id; } catch { resumeId = null; } }
          focus({ surface: 'resume_editor', id: resumeId });
          return text({ opened: 'resume_editor', resume_id: resumeId, note: resumeId ? '已在聊天旁打开简历编辑器，用户可以直接改；改完保存后你可以用 resume_get 读最新内容。' : '已打开简历编辑器，但还没有简历；先用 resume_master_create 生成主简历。' });
        }
        if (args.target === 'live') {
          focus({ surface: 'live_drawer' });
          return text({ opened: 'live_drawer', note: '已在聊天旁打开浏览器现场；用户点画面即可接管。' });
        }
        focus({ surface: args.target, id: args.id ?? null, application_id: args.application_id ?? null, job_id: args.job_id ?? null });
        return text({ opened: args.target });
      })()),

      tool('vault_status', '私密信息库概览：哪些基本信息（姓名 / 手机 / 邮箱 / 证件号…）已填、哪些缺；哪些投递网站存了账号；哪些经历有保密补充字段。只返回字段名、脱敏预览和占位符，永远不返回明文。缺项时对话里会自动出现「补齐基本信息」卡片，用户直接在卡片里填（值不经过你）；不要让用户把这些值打在对话里。', {}, wrap(() => {
        const status = vault().status();
        const core3 = new Set(['name', 'phone', 'email', 'school', 'major', 'degree', 'graduation']);
        const missing = status.profile.missing.filter(m => core3.has(m.field));
        if (missing.length) {
          card('vault_missing', 'vault_missing', '补齐网申基本信息', {
            fields: missing.map(m => { const def = core.PROFILE_FIELDS.find(f => f.field === m.field); return { field: m.field, label: m.label, hint: def?.hint ?? null, sensitive: def?.sensitive ?? false }; }),
          });
        }
        return text({
          ...status,
          placeholders: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}', email: '{{vault:profile.email}}' },
          note: '简历 / 网申草稿里需要这些信息时直接写占位符，导出或填表时会在产品内自动替换成真实值；你拿不到也不需要真实值。',
        });
      })),
      // ---------- 今日 / 收件箱 / 截止 ----------
      tool('today_queue', '今天必须做的事（已排序：过期 / 今天到期 → 待你批准 → 需要你本人 → 今日面试 → 新收件 → 可关闭的静默线）+ 等待中的投递数。给用户最多三件。', {}, wrap(() => text(repos().today()))),

      tool('inbox_capture', '把用户丢进来的任何内容（JD、面试邀请、测评 / 笔试通知、拒信、Offer、内推码、截止提醒）归档成结构化对象：自动建岗位 / 面试 / 截止事件 / 关闭投递 / Offer，并关联到卷宗。', {
        text: z.string().describe('原文'), source: z.enum(['paste', 'file', 'url', 'chat']).optional(), application_id: z.string().optional().describe('用户已明确归属的投递'),
      }, async (args) => wrap(async () => {
        progress('inbox_capture', '正在归档收件箱内容');
        const result = await captureIntake(intakeDeps(), { text: args.text, source: args.source ?? 'chat', application_id: args.application_id ?? null });
        return text({ item_id: result.item.id, kind: result.item.kind, status: result.item.status, created: result.created, summary: result.summary, urgency: result.triage?.urgency ?? null, note: result.item.status === 'new' ? '没能自动归档完，请问用户这属于哪条投递或该怎么处理。' : '已归档，告诉用户落到了哪里即可。' });
      })()),

      tool('inbox_list', '列出收件箱条目（缺省只列待处理的 new）。', { status: z.enum(['new', 'processed', 'dismissed']).optional() }, async (args) => wrap(() => text({ items: repos().listInbox(args.status ?? 'new').map(i => ({ id: i.id, source: i.source, kind: i.kind, status: i.status, note: i.note, preview: i.raw_text.slice(0, 160), created_at: i.created_at })) }))()),

      tool('inbox_dismiss', '把一条收件箱内容标记为忽略（广告、无关邮件、用户说不用管）。', { inbox_id: z.string() }, async (args) => wrap(() => {
        if (!repos().getInboxItem(args.inbox_id)) return err(`收件箱条目不存在：${args.inbox_id}`);
        const item = repos().dismissInboxItem(args.inbox_id);
        changed('inbox_item');
        return text({ item });
      })()),

      tool('deadline_add', '记一个不能丢的时间点：测评 / 笔试 / 面试 / 网申截止 / Offer 回复 / 内推码过期。', {
        kind: z.enum(['assessment', 'written_test', 'interview', 'application_deadline', 'offer_reply', 'referral_expiry', 'other']), title: z.string(), due_at: z.string().describe('ISO 时间，如 2026-10-05T14:00:00+08:00'),
        application_id: z.string().optional(), job_id: z.string().optional(), url: z.string().optional(), note: z.string().optional(),
      }, async (args) => wrap(() => {
        if (Number.isNaN(Date.parse(args.due_at))) return err('due_at 不是可解析的时间');
        const deadline = repos().createDeadline({ kind: args.kind, title: args.title, due_at: new Date(args.due_at).toISOString(), application_id: args.application_id ?? null, job_id: args.job_id ?? null, url: args.url ?? null, note: args.note ?? null, source: 'agent' });
        changed('deadline');
        if (args.application_id) focus({ surface: 'dossier', application_id: args.application_id });
        return text({ deadline });
      })()),

      tool('deadline_done', '把一个时间点标记为已完成 / 取消。', { deadline_id: z.string(), status: z.enum(['done', 'cancelled', 'missed']).optional() }, async (args) => wrap(() => {
        const deadline = repos().setDeadlineStatus(args.deadline_id, args.status ?? 'done');
        changed('deadline');
        return text({ deadline });
      })()),

      // ---------- 卷宗 ----------
      tool('dossier_list', '所有投递的档案摘要（公司、岗位、阶段、静默天数、下一个截止、面试次数）。', {}, wrap(() => text({ dossiers: store().dossierSummaries() }))),

      tool('dossier_get', '面试前一键摊开：这条投递用的哪版简历、开放题填了什么、说过什么、公司调研、预测追问、所有邮件与时间点。按 application_id / job_id / 公司名任一查找。', {
        application_id: z.string().optional(), job_id: z.string().optional(), company_name: z.string().optional(),
      }, async (args) => wrap(() => {
        let appId = args.application_id;
        if (!appId && args.job_id) appId = repos().listApplications().find(a => a.job_id === args.job_id)?.id;
        if (!appId && args.company_name) {
          const hits = repos().findOpenApplicationsByCompany(args.company_name);
          if (hits.length > 1) return err(`${args.company_name} 有 ${hits.length} 条投递，请让用户选：${hits.map(h => `${h.job.title}（${h.id}）`).join('、')}`);
          appId = hits[0]?.id;
        }
        if (!appId) return err('没有找到对应的投递；可以先用 dossier_list 看看');
        const dossier = store().dossier(appId);
        if (!dossier) return err(`投递不存在：${appId}`);
        focus({ surface: 'dossier', application_id: appId });
        return text(dossier);
      })()),

      tool('dossier_note_add', '往卷宗里记一条：对这家公司说过的话（said）、听到的信息（heard）、联系人 / 内推人、备注。面试复盘里的关键表述务必记 said，保证下一轮前后一致。', {
        application_id: z.string(), kind: z.enum(['note', 'said', 'heard', 'contact', 'referral']).optional(), round: z.string().optional(), content: z.string(),
      }, async (args) => wrap(() => {
        const note = repos().addDossierNote({ application_id: args.application_id, kind: args.kind ?? 'note', round: args.round ?? null, content: args.content });
        changed('dossier_note');
        return text({ note });
      })()),

      tool('application_set_stage', '按用户告知推进或关闭一条投递（收到回复 / 进面 / 拿到 Offer / 被拒 / 静默关闭）。沿状态机合法路径自动补中间步骤。', {
        application_id: z.string(), stage: z.enum(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired', 'skip']), note: z.string().optional(),
      }, async (args) => wrap(() => {
        const application = repos().jumpTo(args.application_id, args.stage, args.note);
        changed('application', 'application_history');
        focus({ surface: 'dossier', application_id: application.id });
        return text({ application });
      })()),

      // ---------- 素材 ----------
      tool('material_list', '素材库：开放题答案、项目故事、自我介绍等可复用说法（含是否已确认、适用公司）。', { kind: z.enum(['open_question', 'project_story', 'self_intro', 'why_company', 'why_role', 'strength_weakness', 'career_plan', 'other']).optional() }, async (args) => wrap(() => text({ materials: repos().listMaterials(args.kind ? { kind: args.kind } : {}) }))()),

      tool('material_draft', '起草一段素材（开放题 / 项目故事 / 自我介绍 / 为什么选我们）：优先复用已有素材，只用已确认主张，并核对对这家公司前后说法是否矛盾。返回草稿与 conflicts；用户确认后用 material_save 存。', {
        kind: z.enum(['open_question', 'project_story', 'self_intro', 'why_company', 'why_role', 'strength_weakness', 'career_plan', 'other']), question: z.string(), length: z.string().optional().describe('如 "300 字" 或 short|medium|long'),
        job_id: z.string().optional(), application_id: z.string().optional(), company_name: z.string().optional(), extra: z.string().optional(),
      }, async (args) => wrap(async () => {
        progress('material_draft', '正在起草并核对一致性');
        const out = await draftMaterial(intakeDeps(), { kind: args.kind, question: args.question, length: args.length, job_id: args.job_id ?? null, application_id: args.application_id ?? null, company_name: args.company_name ?? null, extra: args.extra });
        return text({ ...out.output, reused_count: out.reused.length, said_before_count: out.said_before.length, note: out.output.conflicts?.length ? '存在与之前说法的矛盾，先让用户决定以哪个版本为准，再保存。' : '把草稿给用户看；确认后调用 material_save，并在实际使用时调用 material_use_record。' });
      })()),

      tool('material_save', '把用户确认的说法存进素材库。', {
        kind: z.enum(['open_question', 'project_story', 'self_intro', 'why_company', 'why_role', 'strength_weakness', 'career_plan', 'other']), title: z.string(), content: z.string(),
        question_key: z.string().optional(), length_variant: z.enum(['short', 'medium', 'long']).optional(), claim_ids: z.array(z.string()).optional(), company_scope: z.string().optional().describe('只对某家公司适用时填'), confirmed: z.boolean().optional(),
      }, async (args) => wrap(() => {
        const material = repos().createMaterial({ kind: args.kind, title: args.title, content: args.content, question_key: args.question_key ?? null, length_variant: args.length_variant ?? null, claim_ids: args.claim_ids ?? [], company_scope: args.company_scope ?? null, confirmed: args.confirmed ?? true });
        changed('material');
        focus({ surface: 'material', id: material.id });
        return text({ material });
      })()),

      tool('material_use_record', '记录"对哪家公司在什么场合说了什么"，用于一致性核对。网申填开放题、发邮件、面试里讲项目之后都要记。', {
        material_id: z.string().optional(), application_id: z.string().optional(), job_id: z.string().optional(), company_name: z.string().optional(), context: z.string().describe('网申 / 邮件 / 招呼语 / 面试-一面 …'), content_snapshot: z.string(),
      }, async (args) => wrap(() => {
        const use = repos().recordMaterialUse({ material_id: args.material_id ?? null, application_id: args.application_id ?? null, job_id: args.job_id ?? null, company_name: args.company_name ?? null, context: args.context, content_snapshot: args.content_snapshot });
        changed('material_use');
        return text({ use });
      })()),

      // ---------- 复盘 ----------
      tool('weekly_review', '生成本周复盘：漏斗 + 代理反馈（哪类岗位走得远、挂在哪一环、静默比例）+ 下周策略 + 一个今天就能做的小动作。用户表达自我怀疑时也用它拿数字说话。', {
        week_start: z.string().optional().describe('YYYY-MM-DD，缺省本周一'), user_note: z.string().optional().describe('用户想补充的情况或情绪'),
      }, async (args) => wrap(async () => {
        progress('weekly_review', '正在统计漏斗并生成复盘');
        const out = await generateWeeklyReview(intakeDeps(), { week_start: args.week_start, user_note: args.user_note });
        return text({ review_id: out.review.id, ...out.output, funnel: out.funnel });
      })()),

      // ---------- 邮箱 ----------
      tool('mail_accounts', '已绑定的邮箱与各家邮箱的绑定说明。还没绑定时对话里会出现「绑定邮箱」卡片，用户在卡片里填地址和授权码（不经过你），不要让用户把授权码发到对话里。', {}, wrap(() => {
        const accounts = repos().listMailAccounts();
        const presets = Object.values(MAIL_PRESETS).map(p => ({ provider: p.provider, label: p.label, help: p.help }));
        if (!accounts.length) card('mail_bind', 'mail_bind', '绑定求职邮箱', { presets });
        return text({ accounts: accounts.map(a => ({ id: a.id, provider: a.provider, address: a.address, status: a.status, last_sync_at: a.last_sync_at, last_error: a.last_error })), presets });
      })),

      tool('mail_sync', '立刻同步邮箱：新邮件里的面试邀请 / 测评 / 拒信 / Offer 会自动归档到收件箱与卷宗。', { account_id: z.string().optional() }, async (args) => wrap(async () => {
        progress('mail_sync', '正在同步邮箱');
        const deps = intakeDeps();
        if (args.account_id) {
          const account = repos().getMailAccount(args.account_id);
          if (!account) return err(`邮箱账号不存在：${args.account_id}`);
          return text({ results: [await syncMailAccount(deps, account)] });
        }
        if (repos().listMailAccounts().length === 0) return err('还没有绑定邮箱，请让用户在「收件箱」面板绑定（QQ / 163 / Gmail 等填授权码即可）。');
        return text({ results: await syncAllMailAccounts(deps) });
      })()),

      tool('mail_list', '列出与求职相关的邮件（可按投递过滤）；发出去的投递邮件也在这里。', { application_id: z.string().optional(), direction: z.enum(['in', 'out']).optional(), limit: z.number().int().min(1).max(100).optional() }, async (args) => wrap(() => text({ messages: repos().listMailMessages({ application_id: args.application_id, direction: args.direction, relevance: args.application_id ? undefined : 'job', limit: args.limit ?? 30 }).map(m => ({ id: m.id, direction: m.direction, from: m.from_addr, to: m.to_addr, subject: m.subject, snippet: m.snippet, received_at: m.received_at, kind: m.kind, application_id: m.application_id })) }))()),

      tool('mail_compose', '起草投递邮件（derivatives 技能：标题规范、三段正文、附件命名）并入待审队列；用户在面板批准后才会真正发送。resume_id 给定时自动导出 PDF 作为附件。', {
        to: z.string().describe('收件邮箱'), job_id: z.string().optional(), application_id: z.string().optional(), resume_id: z.string().optional(), account_id: z.string().optional(), notes: z.string().optional().describe('用户对邮件的要求'),
      }, async (args) => wrap(async () => {
        const accounts = repos().listMailAccounts();
        const account = args.account_id ? accounts.find(a => a.id === args.account_id) : accounts[0];
        if (!account) return err('还没有绑定邮箱，请让用户在「收件箱」面板绑定后再发投递邮件。');
        let app = args.application_id ? repos().getApplication(args.application_id) : undefined;
        const job = args.job_id ? requireJob(args.job_id) : app ? repos().getJob(app.job_id) : undefined;
        if (!job) return err('需要 job_id 或 application_id');
        if (!app) app = repos().listApplications().find(a => a.job_id === job.id) ?? repos().createApplication(job.id, args.resume_id && store().getResume(args.resume_id)?.kind === 'tailored' ? args.resume_id : null);
        const resume = args.resume_id ? store().getResume(args.resume_id) : undefined;
        let attachment: { path: string; filename: string } | null = null;
        let packetId: string | null = null;
        if (resume) {
          progress('mail_compose', '正在冻结简历附件（快照 + PDF）');
          // 附件按内容哈希冻结：批准后再导出 / 改简历，发出去的仍是批准时那一份
          const { packet, warning } = await freezePacket(packetDeps(), { applicationId: app.id, jobId: job.id, resumeId: resume.row.id });
          if (warning || !packet.resume_pdf_path) return err(warning ?? '简历 PDF 导出失败');
          packetId = packet.id;
          attachment = { path: packet.resume_pdf_path, filename: `${resume.kind === 'master' ? (resume.row as { name?: string }).name ?? '简历' : '简历'}.pdf` };
        }
        progress('mail_compose', '正在起草邮件');
        const basics = resume ? (parseJson<{ basics?: Record<string, string> }>(resume.row.schema_json)?.basics ?? {}) : {};
        const out = await askSkill<{ email?: { subject?: string; body?: string; signature?: string }; attachment_name?: string; matches_used?: unknown; unresolved?: unknown }>('derivatives', `${jobDigest(job)}\n\n用户基本信息：${JSON.stringify(basics)}\n\n已确认主张：\n${experienceDigest()}\n\n附件实际文件名：${attachment?.filename ?? '（无附件）'}\n用户要求：${args.notes ?? '无'}`, { temperature: 0.3 });
        if (attachment && out.attachment_name && /\.pdf$/i.test(out.attachment_name)) attachment = { ...attachment, filename: out.attachment_name };
        const subject = out.email?.subject ?? `应聘 ${job.title}`;
        const body = [out.email?.body ?? '', out.email?.signature ?? ''].filter(Boolean).join('\n\n');
        const action = repos().enqueueAction('send_mail', { account_id: account.id, to: args.to, subject, body, attachments: attachment ? [{ ...attachment, sha256: packetId ? repos().getPacket(packetId)?.resume_pdf_sha256 ?? undefined : undefined }] : [], application_id: app.id, job_id: job.id, context: '邮件', ...(packetId ? { packet_id: packetId } : {}) }, app.id);
        changed('action_queue', 'application');
        review([action.id], 'send_mail', `发送投递邮件给 ${args.to}：${subject}`);
        focus({ surface: 'today' });
        return text({ action_id: action.id, subject, body, attachment: attachment?.filename ?? null, unresolved: out.unresolved ?? [], note: '邮件已进入待审核队列，用户在「今日」或卷宗里批准后才会发送；请把主题与正文给用户确认。' });
      })()),

      tool('experience_add', '写入一段经历到经历库，并附带若干主张（claims，状态一律 pending，需用户确认后才能进简历）。', {
        title: z.string().describe('经历标题'), role: z.string().optional(), org: z.string().optional(),
        start_date: z.string().optional().describe('YYYY-MM'), end_date: z.string().optional().describe('YYYY-MM，在职/进行中留空'),
        type: z.enum(['dev', 'data', 'pm', 'ops', 'design', 'marketing', 'finance', 'education', 'admin', 'other']).optional(),
        summary: z.string().optional(), redacted: z.boolean().optional().describe('用户只提供了脱敏摘要'),
        claims: z.array(z.object({ text: z.string(), attribution: z.enum(['self', 'team', 'unknown']).optional(), result_metric: z.string().optional() })).optional(),
      }, async (args) => wrap(() => {
        const r = repos();
        const experience = r.createExperience({ title: args.title, role: args.role ?? null, org: args.org ?? null, start_date: args.start_date ?? null, end_date: args.end_date ?? null, type: args.type, summary: args.summary ?? null, redacted: args.redacted ? 1 : 0 });
        const claims = (args.claims ?? []).map(c => r.addClaim({ experience_id: experience.id, text: c.text, attribution: c.attribution, result_metric: c.result_metric ?? null, created_from: 'interview' }));
        changed('experience', 'claim');
        if (claims.length) {
          card(`claims:${experience.id}`, 'claims_confirm', `确认「${experience.title}」里的 ${claims.length} 条说法`, {
            experience_id: experience.id, experience_title: experience.title,
            claims: claims.map(c => ({ id: c.id, text: c.text, result_metric: c.result_metric ?? null, attribution: c.attribution ?? null })),
          });
        }
        return text({ experience, claims, note: '主张状态为 pending；对话里已出现确认卡片，用户可以直接逐条勾选确认，也可以口头确认后调用 claim_confirm。' });
      })()),

      tool('experience_list', '返回整棵经历树（经历 → 主张 → 证据）。', {}, wrap(() => text(repos().experienceTree()))),

      tool('claim_confirm', '用户口头确认某条主张后调用，把 claim 置为 user_confirmed。', { claim_id: z.string() }, async (args) => wrap(() => {
        const claim = repos().listClaims().find(c => c.id === args.claim_id);
        if (!claim) return err(`主张不存在：${args.claim_id}`);
        repos().confirmClaim(args.claim_id);
        changed('claim');
        return text({ ok: true, claim_id: args.claim_id, status: 'user_confirmed' });
      })()),

      tool('ingest_document', '用 docparse 解析本地文档（简历 / 实习证明 / 项目报告），抽取主张写入经历库（pending）并附 doc_fragment 证据。', {
        path: z.string().describe('本地文件绝对路径'), experience_id: z.string().optional().describe('归属的经历；缺省新建一条以文件名命名的经历'),
      }, async (args) => wrap(async () => {
        const bridges = await loadBridges();
        progress('ingest_document', `正在解析文档 ${basename(args.path)}`);
        const doc = await bridges.parseDocument(args.path, { to: ['md'] });
        const markdown = doc.markdown ?? '';
        if (!markdown.trim()) return err('docparse 没有产出文本（文件可能是图片扫描件，需开启 OCR）');
        const out = await askSkill<{ claims?: Array<{ text: string; attribution?: 'self' | 'team' | 'unknown'; result_metric?: string; excerpt?: string }> }>(
          'experience-interview', `以下是用户上传的文档《${basename(args.path)}》解析出的 Markdown。请只抽取可核验的事实主张，输出 JSON：{"claims":[{"text":"","attribution":"self|team|unknown","result_metric":"","excerpt":"原文片段"}]}。\n\n${markdown.slice(0, 30_000)}`, { temperature: 0.1 });
        const r = repos();
        const experienceId = args.experience_id ?? r.createExperience({ title: basename(args.path), type: 'other', summary: '由文档导入' }).id;
        const claims = (out.claims ?? []).map(c => {
          const claim = r.addClaim({ experience_id: experienceId, text: c.text, attribution: c.attribution, result_metric: c.result_metric || null, created_from: 'doc' });
          r.addEvidence({ claim_id: claim.id, kind: 'doc_fragment', locator: args.path, excerpt: c.excerpt ?? null, strength: 'mid' });
          return claim;
        });
        changed('experience', 'claim', 'evidence');
        return text({ experience_id: experienceId, claims, note: '主张均为 pending，需用户确认。' });
      })()),

      tool('ingest_repo', '用 repoMiner 挖掘本地 git 仓库里的个人贡献，生成主张 + commit 证据（pending）。', {
        repoPath: z.string(), author: z.string().optional().describe('git 作者名或邮箱'), experience_id: z.string().optional(), jd: z.string().optional().describe('目标 JD，用于聚焦'),
      }, async (args) => wrap(async () => {
        const bridges = await loadBridges();
        progress('ingest_repo', `正在分析仓库 ${basename(args.repoPath)}`);
        const result = await bridges.mineRepo(args.repoPath, { llm: llm(), author: args.author, jd: args.jd });
        const r = repos();
        const experienceId = args.experience_id ?? r.createExperience({ title: basename(args.repoPath), type: 'dev', summary: '由代码仓库导入' }).id;
        const imported = bridges.importMineResult(r, experienceId, result);
        changed('experience', 'claim', 'evidence');
        return text({ experience_id: experienceId, claims: imported.claims, evidence_count: imported.evidence.length, notes: result.notes, dropped: result.dropped });
      })()),

      // ---------- 岗位 ----------
      tool('jd_parse', '九类 JD 分析 + 关键词三分类，结果存入 job.jd_parsed_json；没有 job_id 时新建岗位。', {
        jd_raw: z.string().optional(), url: z.string().optional(), job_id: z.string().optional(), company_name: z.string().optional(), title: z.string().optional(),
      }, async (args) => wrap(async () => text(await parseAndStoreJd(args)))()),

      tool('job_import', '把岗位加入岗位池（url 或 jd_raw），有 JD 文本时顺带解析。', {
        url: z.string().optional(), jd_raw: z.string().optional(), title: z.string().optional(), company_name: z.string().optional(),
        source_platform: z.enum(['boss', 'liepin', 'zhilian', '51job', 'campus', 'ats', 'manual']).optional(),
      }, async (args) => wrap(async () => {
        if (!args.url && !args.jd_raw) return err('url 或 jd_raw 至少提供一个');
        if (args.jd_raw) return text(await parseAndStoreJd(args));
        const job = repos().upsertJob({ source_platform: args.source_platform ?? 'manual', title: args.title ?? '未命名岗位', url: args.url ?? null, company_name: args.company_name ?? null });
        changed('job');
        return text({ job, note: '只记录了链接；需要 JD 文本才能解析与评分。' });
      })()),

      tool('job_evaluate', '岗位硬约束预筛 + 五维评分 + 投递建议（投不投由用户决定），写入 job.prefilter_json / score_json。', { job_id: z.string() }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const jd = jdOf(job);
        if (!jd) return err('该岗位还没有解析 JD，请先调用 jd_parse');
        const company = store().findCompany(job.company_name ?? '');
        const out = await askSkill<Record<string, unknown>>('job-evaluate', `JdParsed：\n${JSON.stringify(jd)}\n\n求职偏好：\n${JSON.stringify(prefs())}\n\n经历库已确认主张：\n${experienceDigest()}\n\n公司调研结论：${company?.traffic_light ?? '无'}`, { temperature: 0.2 });
        const prefilter = out.prefilter ?? out.hard_constraints ?? null;
        repos().db.update('job', job.id, { prefilter_json: prefilter ? JSON.stringify(prefilter) : null, score_json: JSON.stringify(out), updated_at: new Date().toISOString() });
        changed('job');
        return text({ job_id: job.id, evaluation: out });
      })()),

      // ---------- 简历 ----------
      tool('resume_list', '列出所有主简历与针对岗位的定制版（id、名称、方向、条目数、是否已确认）。定制前用它找 master_id。', {}, wrap(() => {
        const s = store();
        return text({
          masters: s.listResumeMasters().map(resumeSummary),
          tailored: s.listResumeTailored().map(t => ({ ...resumeSummary({ ...t, name: undefined, direction: null }), master_id: t.master_id, job_id: t.job_id, strength: t.strength, confirmed: !!t.diff_confirmed_at })),
        });
      })),

      tool('resume_master_create', '创建主简历（母版）：默认从经历库已确认主张起草一份完整简历；basics / education 只填用户亲口给的信息，不编造。经历库为空时也能先建空壳，用户之后在「简历」页或通过 resume_save 补内容。', {
        name: z.string().optional().describe('主简历名称，如"通用版"、"数据分析方向"；缺省按方向或"主简历"'),
        direction: z.string().optional().describe('求职方向'),
        basics: basicsSchema.optional().describe('用户明确给出的基本信息'),
        education: z.array(educationSchema).optional().describe('用户明确说过的教育背景'),
        draft: z.boolean().optional().describe('是否用模型从经历库起草内容；缺省 true（有已确认主张才会真正起草）'),
        notes: z.string().optional().describe('用户对简历的额外要求'),
      }, async (args) => wrap(async () => {
        const s = store();
        const name = args.name?.trim() || (args.direction ? `${args.direction}方向` : '主简历');
        const claims = confirmedClaims();
        const pendingCount = repos().listClaims().length - claims.length;
        // 姓名 / 手机 / 邮箱 / 城市：私密库里有就写占位符（导出时才解成明文），模型给的明文值不覆盖占位符
        const vaultBasics: Record<string, string> = {};
        const filled = new Set(vault().status().profile.filled.map(f => f.field));
        for (const [field, key] of [['name', 'name'], ['phone', 'phone'], ['email', 'email'], ['city', 'city'], ['politics', 'political_status']] as const) {
          if (filled.has(field)) vaultBasics[key] = core.vaultPlaceholder('profile', '', field);
        }
        const basics = { ...(args.basics ?? {}), ...vaultBasics };
        const base = { version: 1, basics, education: args.education ?? [] };
        let draft: Record<string, unknown> | undefined;
        let missing: unknown = [];
        let usedClaimIds: unknown = [];
        let draftNotes = '';
        if ((args.draft ?? true) && claims.length > 0) {
          progress('resume_master_create', '正在从经历库起草主简历');
          const out = await askSkill<{ resume?: Record<string, unknown>; missing?: unknown; used_claim_ids?: unknown; notes?: string }>('resume-draft', `用户基本信息：\n${JSON.stringify(basics)}\n\n用户口述的教育背景：\n${JSON.stringify(args.education ?? [])}\n\n求职方向：${args.direction ?? '未指定'}\n用户额外要求：${args.notes ?? '无'}\n\n经历库（只用 user_confirmed / verified 主张）：\n${experienceDigest()}`, { temperature: 0.2 });
          if (out.resume && typeof out.resume === 'object') {
            // 基本信息与教育以用户亲口给的为准，模型不得覆盖；私密库占位符优先级最高。
            draft = { ...out.resume, version: 1, basics: { ...(out.resume.basics as Record<string, unknown> | undefined ?? {}), ...basics }, ...(args.education?.length ? { education: args.education } : {}) };
          }
          missing = out.missing ?? [];
          usedClaimIds = out.used_claim_ids ?? [];
          draftNotes = out.notes ?? '';
        }
        const schema = await normalizeResume(draft ?? base);
        const master = s.createResumeMaster({ name, direction: args.direction ?? null, schema_json: schema });
        changed('resume_master');
        focus({ surface: 'material', id: master.id, note: '主简历已创建' });
        const note = draft
          ? '主简历已起草并保存，请把各分区内容简要复述给用户确认；用户想改哪里就用 resume_save 改，之后可用 resume_tailor 按岗位定制。'
          : claims.length === 0
            ? `经历库里还没有已确认的主张（${pendingCount > 0 ? `有 ${pendingCount} 条待确认` : '经历库为空'}），已先创建只含基本信息的主简历。请引导用户先补充经历并逐条确认主张，再调用 resume_save 或重新起草。`
            : '已按 draft=false 创建只含基本信息的主简历。';
        return text({ master: resumeSummary(master), master_id: master.id, drafted: !!draft, confirmed_claims: claims.length, used_claim_ids: usedClaimIds, missing, notes: draftNotes, note });
      })()),

      tool('resume_get', '读取一份简历（主简历或定制版）的完整 JSON 内容。', { resume_id: z.string().optional().describe('缺省取唯一的主简历') }, async (args) => wrap(() => {
        const found = args.resume_id ? store().getResume(args.resume_id) : { kind: 'master' as const, row: resolveMaster() };
        if (!found) return err(`简历不存在：${args.resume_id}`);
        return text({ id: found.row.id, kind: found.kind, resume: parseJson(found.row.schema_json) ?? {} });
      })()),

      tool('resume_save', '按用户要求直接改简历内容并保存（覆盖前自动存快照）。传完整 resume JSON 或 JSON Patch 二选一；只能用已确认主张，不改用户基本事实。', {
        resume_id: z.string().optional().describe('缺省取唯一的主简历'),
        resume: z.record(z.string(), z.unknown()).optional().describe('完整的简历 JSON（schema v1）'),
        patch: z.array(z.object({ op: z.enum(['add', 'replace', 'remove']), path: z.string(), value: z.unknown().optional() })).optional().describe('在当前内容上应用的 JSON Patch'),
        note: z.string().optional().describe('快照备注，如"用户要求补充邮箱"'),
      }, async (args) => wrap(async () => {
        if (!args.resume && !args.patch?.length) return err('resume 或 patch 至少提供一个');
        const s = store();
        const found = args.resume_id ? s.getResume(args.resume_id) : { kind: 'master' as const, row: resolveMaster() };
        if (!found) return err(`简历不存在：${args.resume_id}`);
        const current = parseJson(found.row.schema_json) ?? {};
        const next = args.resume ?? applyJsonPatch(current, args.patch ?? []);
        const schema = await normalizeResume(next);
        const row = s.saveResume(found.row.id, schema, args.note ?? '助理修改前快照');
        changed(found.kind === 'master' ? 'resume_master' : 'resume_tailored', 'resume_snapshot');
        return text({ id: row.id, kind: found.kind, applied_ops: args.resume ? null : (args.patch?.length ?? 0), resume: schema });
      })()),

      tool('resume_tailor', '按 JD 定制简历：只用已确认主张，生成 JSON Patch 提案与逐条理由（提案不落库，先给用户看 diff），同时创建一条未确认的 tailored 记录供 resume_confirm 使用。', {
        master_id: z.string().optional().describe('缺省取唯一的主简历；没有主简历时先调用 resume_master_create'), job_id: z.string(), strength: strengthEnum.optional(),
      }, async (args) => wrap(async () => {
        const s = store();
        const masterRow = resolveMaster(args.master_id);
        const master = { row: masterRow };
        const job = requireJob(args.job_id);
        const jd = jdOf(job);
        if (!jd) return err('该岗位还没有解析 JD，请先调用 jd_parse');
        const strength = args.strength ?? 'keywords';
        const out = await askSkill<Record<string, unknown>>('resume-tailor', `母版简历 schema：\n${master.row.schema_json}\n\nJdParsed：\n${JSON.stringify(jd)}\n\n可用主张（仅 user_confirmed / verified）：\n${confirmedClaims().map(c => `- [${c.id}] ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '（无）'}\n\n强度：${strength}`, { refs: ['风格库', '岗位速查'], temperature: 0.2 });
        const tailored = s.createTailored({ master_id: masterRow.id, job_id: args.job_id, schema_json: master.row.schema_json, strength });
        repos().kvSet(`tailor_proposal:${tailored.id}`, out);
        changed('resume_tailored');
        const proposal = readTailorProposal(repos(), tailored.id);
        if (proposal.ops.length) {
          card(`resume_diff:${tailored.id}`, 'resume_diff', `为「${job.title ?? '该岗位'}」定制简历：${proposal.ops.length} 处改动`, {
            tailored_id: tailored.id, job_id: args.job_id,
            ops: proposal.ops.slice(0, 30).map(o => ({ op: o.op, path: o.path, value: typeof o.value === 'string' ? o.value : o.value === undefined ? null : JSON.stringify(o.value), reason: proposal.reasons.find(r => r.path === o.path)?.reason ?? null })),
            unresolved: proposal.unresolved.slice(0, 10),
          });
        }
        return text({ tailored_id: tailored.id, proposal: out, note: '对话里已出现「简历改动」卡片，用户可以逐条勾选后一键应用；用户口头确认时再调用 resume_confirm。' });
      })()),

      tool('resume_confirm', '用户确认 diff 后，把 resume_tailor 的提案应用到 tailored 简历并落库。', {
        tailored_id: z.string(), accepted_paths: z.array(z.string()).optional().describe('只应用这些 JSON Pointer 路径的改动；缺省全部'),
      }, async (args) => wrap(() => {
        const result = confirmTailorProposal(store(), repos(), args.tailored_id, args.accepted_paths);
        if (!result) return err(`定制简历不存在：${args.tailored_id}`);
        changed('resume_tailored', 'resume_snapshot');
        return text({ tailored: result.tailored, applied_ops: result.applied });
      })()),

      tool('resume_export', '导出简历为 pdf / docx / png，返回文件路径。', { resume_id: z.string(), format: z.enum(EXPORT_FORMATS) }, async (args) => wrap(async () => {
        if (!isExportFormat(args.format)) return err('format 必须是 pdf | docx | png');
        progress('resume_export', `正在导出 ${args.format}`);
        const path = await exportWithVault(args.resume_id, args.format);
        changed('resume_tailored');
        return text({ path });
      })()),

      // ---------- 调研 / 搜索 ----------
      tool('company_research', '求职视角的公司研究：结合 Web Search 产出九段报告、红绿灯与人工核实清单，写入 company 表。', {
        company_name: z.string(), hints: z.string().optional().describe('城市 / 地址 / 岗位等消歧信息'),
      }, async (args) => wrap(async () => {
        const hits: unknown[] = [];
        try {
          const provider = await search();
          if (!provider) card('search_setup', 'search_setup', '配置搜索 Key（建议）', { reason: 'company_research' });
          if (provider) {
            progress('company_research', `正在搜索 ${args.company_name}`);
            const queries = [`${args.company_name} 公司 招聘 评价`, `${args.company_name} 工商 信息 风险`, `${args.company_name} 面试 经验`];
            for (const q of queries) hits.push(...(await provider.search(q, { count: 5 })));
          }
        } catch (error) {
          console.warn('[career] company_research 搜索失败，继续用模型已有知识:', error instanceof Error ? error.message : error);
        }
        // TODO(intel-compass)：接入 @career/bridges 的 IntelCompassClient（本地 HTTP），有服务时优先使用其九段报告。
        const out = await askSkill<Record<string, unknown>>('company-research', `公司名：${args.company_name}\n消歧信息：${args.hints ?? '无'}\n\nWeb Search 结果（${hits.length} 条）：\n${JSON.stringify(hits).slice(0, 20_000)}`, { refs: ['红线与风险信号'], temperature: 0.2 });
        const trafficLight = typeof out.traffic_light === 'string' ? out.traffic_light : null;
        const company = store().upsertCompany(args.company_name, { dd_report_json: out, traffic_light: trafficLight, manual_checks: out.manual_checks ?? [] });
        changed('company');
        return text({ company, report: out, search_hits: hits.length, ...(hits.length ? {} : { note: '这次没有联网搜索结果，报告只基于模型已有知识，请提醒用户核实；搜索没配置时对话里会出现「配置搜索 Key」卡片。' }) });
      })()),

      tool('web_search', '唯一允许的外部动作：Web 搜索（博查 / Tavily / Serper）。', {
        query: z.string(), count: z.number().int().min(1).max(20).optional(),
      }, async (args) => wrap(async () => {
        const provider = await search();
        if (!provider) {
          card('search_setup', 'search_setup', '配置搜索 Key（建议）', { reason: 'web_search' });
          return err(SEARCH_NOT_CONFIGURED_MESSAGE);
        }
        progress('web_search', `搜索：${args.query}`);
        return text(await provider.search(args.query, { count: args.count ?? 8 }));
      })()),

      // ---------- 投递 ----------
      tool('apply_prepare', '为岗位创建投递记录，把要投的简历冻结成材料包（简历快照 + PDF + JD 原文），并把 fill_form 动作入待审队列；用户在卡片上批准后，产品后台会自动打开网申页面填写（不需要再调 apply_run）。不传 resume_id 时：用这个岗位的定制简历，没有就用唯一一份主简历；有多份主简历时会报错，请先让用户选。', {
        job_id: z.string(), resume_id: z.string().optional().describe('要投的简历 id（主简历或定制简历）'),
      }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const r = repos();
        const picked = pickResumeForJob(store(), job.id, args.resume_id);
        if (args.resume_id && !picked) return err(`简历不存在：${args.resume_id}`);
        if (!picked && store().listResumeMasters().length > 1) return err(`有多份主简历，请先调用 resume_list 让用户选择这次投哪一份，再带上 resume_id：${store().listResumeMasters().map(m => `${m.id}（${m.name}）`).join('、')}`);
        const application = r.createApplication(job.id, picked?.kind === 'tailored' ? picked.id : null);
        progress('apply_prepare', '正在冻结投递材料包（简历快照 + PDF）');
        const { packet, warning } = await freezePacket(packetDeps(), { applicationId: application.id, jobId: job.id, resumeId: picked?.id ?? null });
        const action = r.enqueueAction('fill_form', { job_id: job.id, resume_id: picked?.id ?? null, packet_id: packet.id, application_id: application.id, url: job.url }, application.id);
        changed('application', 'action_queue');
        review([action.id], 'fill_form', `为「${job.company_name ?? ''} ${job.title}」填写网申表单${picked ? `（简历：${picked.reason}）` : '（没有简历附件）'}`);
        return text({ application, action, packet: { id: packet.id, resume_id: packet.resume_id, resume_kind: packet.resume_kind, resume_pick_reason: picked?.reason ?? null, has_pdf: !!packet.resume_pdf_path }, ...(warning ? { warning } : {}), note: '动作已进入待审核队列，对话里有批准卡片；批准的是这份材料包（之后再改简历不影响这次投递）。用户批准后产品后台会立刻打开网申页面填写，进度显示在对话里的浏览器卡片上；遇到登录 / 验证码会在对话里请用户接管，填好后会弹出提交审核卡片。不需要你再调用 apply_run。' });
      })()),

      tool('jobs_board', '岗位汇总表（校招 / 实习网申汇总 + 我的进度 + 可解释匹配）。按条件筛选、按匹配分排序；每条带"哪条要求对应用户哪段经历"。推荐时只推荐 fits=true 的（不违反用户明确条件）。', {
        q: z.string().optional(), employment_type: z.enum(['campus', 'intern', 'social']).optional(), city: z.string().optional(), cohort: z.string().optional().describe('如 2027届'),
        open_only: z.boolean().optional().describe('只看没截止的'), fits_only: z.boolean().optional().describe('只看符合用户条件的'), progress: z.enum(['none', 'active', 'done']).optional(),
        sort: z.enum(['match', 'deadline', 'updated']).optional(), limit: z.number().int().min(1).max(50).optional(),
      }, async (args) => wrap(async () => {
        const { jobBoard, getJobPrefs } = await import('../career/job-board');
        const rows = jobBoard(repos(), { ...args, limit: args.limit ?? 15 });
        return text({ prefs: getJobPrefs(repos()), rows: rows.map(({ job, match, application }) => ({
          job_id: job.id, job_key: job.job_key, company: job.company_name, title: job.title, type: job.employment_type, cohort: job.cohort, location: job.location, deadline: job.deadline,
          url: job.url, progress: application?.stage ?? null, score: match?.score ?? null, fits: match?.hard_ok ?? null, summary: match?.summary ?? '尚未计算匹配',
          hard: match?.hard.filter(h => h.ok !== true).map(h => `${h.label}：${h.detail}`), covered: match?.requirements.filter(r => r.status === 'covered').map(r => `${r.requirement} ← ${r.evidence?.label ?? ''}「${r.evidence?.text.slice(0, 40) ?? ''}」`),
          missing: match?.requirements.filter(r => r.status === 'missing').map(r => r.requirement),
        })), note: rows.length ? '匹配基于用户已确认的经历与简历文字；missing 里的要求不能替用户编造，只能建议去补证据或在面试准备里说明。' : '没有符合条件的岗位：可先 jobs_sync 同步校招数据，或放宽条件。' });
      })()),

      tool('jobs_sync', '同步岗位到本地汇总表：campus = 内置校招 / 实习汇总数据；server = 服务端共享岗位库（需已配置服务端地址）。同步后自动重算匹配。', {
        source: z.enum(['campus', 'server']),
      }, async (args) => wrap(async () => {
        const r = repos();
        const { computeMatches } = await import('../career/job-board');
        let result: { fetched: number; stored: number };
        if (args.source === 'server') {
          const { serverConfig, RemoteJobSource, syncJobSource } = await import('../career/server-api');
          const cfg = serverConfig(r);
          if (!cfg) return err('还没有配置服务端地址：让用户在 设置 → 求职助理 填写，或先用 campus 来源。');
          result = await syncJobSource(r, new RemoteJobSource(cfg), { updated_since: r.kvGet<string>('jobs:server:synced_at') ?? undefined });
          r.kvSet('jobs:server:synced_at', new Date().toISOString());
        } else {
          const bridges = await loadBridges();
          const items = bridges.filterCampusJobs(bridges.loadCampusJobs(), { excludeExpired: false });
          result = { fetched: items.length, stored: bridges.importCampusJobs(r, items).length };
        }
        const matched = computeMatches(r, store());
        changed('job');
        return text({ source: args.source, ...result, matched });
      })()),

      tool('job_prefs', '查看或设置用户的求职条件（届别 / 最高学历 / 城市 / 校招实习类型 / 方向词）。这些是硬条件：岗位推荐不得违反。设置后自动重算全部岗位匹配。只记录用户明确说过的条件，不要替用户猜。', {
        cohort: z.string().optional().describe('如 2027届'), degree: z.enum(['大专', '本科', '硕士', '博士']).optional(), cities: z.array(z.string()).optional(),
        employment_types: z.array(z.enum(['campus', 'intern', 'social'])).optional(), keywords: z.array(z.string()).optional(),
      }, async (args) => wrap(async () => {
        const { getJobPrefs, setJobPrefs, computeMatches } = await import('../career/job-board');
        const r = repos();
        if (Object.values(args).every(v => v === undefined)) return text({ prefs: getJobPrefs(r) });
        const prefs = setJobPrefs(r, { ...getJobPrefs(r), ...args });
        const n = computeMatches(r, store());
        changed('job', 'kv');
        return text({ prefs, rematched: n });
      })()),

      tool('jobs_prepare', '把多个岗位一次加入待投清单（每个都冻结材料包 + fill_form 待审）；已在投的跳过。用户在待投清单勾选 / 全选批准后由后台批量投递执行。', {
        job_ids: z.array(z.string()).min(1).max(50), resume_id: z.string().optional().describe('统一用这份简历；不传则每个岗位用它的定制版或唯一主简历'),
      }, async (args) => wrap(async () => {
        const { prepareJobs } = await import('../career/job-board');
        progress('jobs_prepare', `正在为 ${args.job_ids.length} 个岗位准备材料包`);
        const results = await prepareJobs({ ...packetDeps(), store: store() }, args.job_ids, args.resume_id ?? null);
        changed('application', 'action_queue');
        const queued = results.filter(x => x.ok).map(x => x.action_id!).filter(Boolean);
        if (queued.length) review(queued, 'fill_form', `${queued.length} 个岗位已加入待投清单，勾选批准后开始批量填写`);
        return text({ results, queued: queued.length });
      })()),

      tool('apply_run', '在托管浏览器上执行已批准的填表动作（不提交）。通常不需要：用户批准后产品后台会自动执行；只在动作仍停在 approved（后台没接走）时用；遇验证码 / 登录 / 测评等自动暂停并交给用户接管，用户处理完后调用 apply_continue 从当前页继续。', { action_id: z.string() }, async (args) => wrap(async () => {
        const action = repos().getAction(args.action_id);
        if (!action) return err(`动作不存在：${args.action_id}`);
        if (action.status !== 'approved') return err(`动作状态为 ${action.status}，只能执行已批准（approved）的动作${action.status === 'needs_user' || action.status === 'executing' ? '；要从接管处继续请用 apply_continue' : ''}`);
        return runDrive(action, 'start');
      })()),

      tool('apply_batch', '批量投递（后台长程）：把「岗位与投递」里所有已批准的填表动作排队，由产品后台一份份填（遇登录 / 验证码停下等用户，交回后自动继续，两份之间拟人停顿，平台风控时跳过）。command=start 开始或继续、pause 当前这份填完就停、stop 立即停、status 只看进度。用户可在「浏览器现场」页实时观看。', {
        command: z.enum(['start', 'pause', 'stop', 'status']),
      }, async (args) => wrap(async () => {
        const { BatchRunner } = await import('../career/batch-runner');
        const r = repos();
        const peek = new BatchRunner({ repos: r, drive: async () => { throw new Error('只读'); }, control: () => 'agent', broadcast: () => {} });
        if (args.command !== 'status') {
          BatchRunner.command(r, args.command, 'assistant');
          changed('task');
        }
        const state = peek.state();
        const note = args.command === 'status'
          ? '以上是后台批量投递的当前状态；想看画面让用户打开「浏览器现场」页。'
          : `已向后台下发 ${args.command}；状态几秒内更新，可再用 status 查看。注意：批量运行器只在桌面端（Global 侧车）运行。`;
        return text({ command: args.command, batch: state, note });
      })()),

      tool('apply_continue', '用户在浏览器里处理完登录 / 验证码 / 测评并交还后，从当前页面继续填表（不重新打开链接，不提交）。', { action_id: z.string().describe('之前 apply_run 的 action_id') }, async (args) => wrap(async () => {
        const action = repos().getAction(args.action_id);
        if (!action) return err(`动作不存在：${args.action_id}`);
        if (action.status !== 'needs_user' && action.status !== 'executing') return err(`动作状态为 ${action.status}，只有接管中（needs_user / executing）的填表动作可以继续`);
        return runDrive(action, 'continue');
      })()),

      tool('greeting_compose', '生成平台招呼语（≤120 字）并自评审，入 send_greeting 待审队列；永远不会直接发送。', {
        job_id: z.string(), preferences: z.string().optional().describe('用户的招呼语偏好'),
      }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const recent = repos().listActions().filter(a => a.kind === 'send_greeting').slice(0, 5).map(a => parseJson<{ text?: string }>(a.payload_json)?.text?.slice(0, 12)).filter(Boolean);
        const out = await askSkill<{ greeting?: string; char_count?: number; review?: unknown; evidence?: unknown }>('greeting', `${jobDigest(job)}\n\n用户已确认经历摘要：\n${experienceDigest()}\n\n招呼语偏好：${args.preferences ?? '无'}\n最近用过的开头（避免雷同）：${JSON.stringify(recent)}`, { temperature: 0.6 });
        if (!out.greeting) return err('模型没有给出招呼语');
        const app = repos().listApplications().find(a => a.job_id === job.id);
        const action = repos().enqueueAction('send_greeting', { job_id: job.id, text: out.greeting, review: out.review, evidence: out.evidence }, app?.id ?? null);
        changed('action_queue');
        review([action.id], 'send_greeting', `向「${job.company_name ?? ''} ${job.title}」发送招呼语`);
        return text({ action_id: action.id, greeting: out.greeting, review: out.review, status: action.status });
      })()),

      tool('apply_auto_mode', '查看或切换投递 auto 模式。开启后：填完检查全部通过的网申会直接提交，不再等用户批准；有任何需要人看的项仍会停下。只在用户明确要求时开启 / 关闭。另：同一张表用户连续 3 次直接批准、简历与开放题答案没变时，会自动免确认（自学习，不受此开关影响）。', {
        enabled: z.boolean().optional().describe('不传只查看'),
      }, async (args) => wrap(async () => {
        const { getAutoMode, setAutoMode, LEARN_THRESHOLD } = await import('../career/submit-policy');
        const r = repos();
        const cur = args.enabled === undefined ? getAutoMode(r) : setAutoMode(r, args.enabled);
        if (args.enabled !== undefined) changed('kv');
        return text({ auto_mode: cur.enabled, learn_threshold: LEARN_THRESHOLD });
      })()),

      tool('review_queue', '列出动作队列（默认 pending_review）。', {
        status: z.enum(['pending_review', 'approved', 'executing', 'needs_user', 'done', 'failed', 'rejected']).optional(),
      }, async (args) => wrap(() => text(repos().listActions(args.status ?? 'pending_review')))()),

      // ---------- 面试 ----------
      tool('interview_questions', '按岗位与 JD 出一组带追问点的面试题（九类题型），不给标准答案。', {
        job_id: z.string(), round: z.string().optional(), company_type: z.string().optional(),
        category: z.enum(['开发', '数据分析', '产品', '运营', '设计', '市场营销', '销售', 'HR', '财务', '审计', '法务', '战略咨询']).optional(),
      }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const out = await askSkill<{ questions?: Array<{ type?: string; question?: string; probe_points?: string[]; difficulty?: string; jd_requirement?: string }>; coverage_note?: string }>('interview-questions', `${jobDigest(job)}\n岗位类别：${args.category ?? '未知'}\n企业性质：${args.company_type ?? '未知'}\n轮次：${args.round ?? '未知'}\n\n用户经历摘要：\n${experienceDigest()}`, { refs: args.category ? [args.category] : [], temperature: 0.5 });
        // 出的题进题库（来源 generated，绑定岗位），之后练习、真实面试遇到都能对上同一道题
        const r = repos();
        const questions = (out.questions ?? []).filter(q => q?.question).map(q => ({ ...q, question_id: r.upsertQuestion({ content: q.question!, kind: 'interview', category: q.type ?? null, probe_points: q.probe_points ?? [], jd_requirement: q.jd_requirement ?? null, company_name: job.company_name, title: job.title, job_id: job.id, source: 'generated', source_ref: `generated:${job.id}`, tags: q.difficulty ? [q.difficulty] : [] }).id }));
        if (questions.length) changed('question');
        return text({ ...out, questions, note: '题目已存进题库（question_id）。用户练习作答后用 question_attempt 打分记录，便于比较进步。' });
      })()),

      tool('interview_probe', '模拟面试 / 简历深挖：漏斗追问。首轮不传 transcript 时给开场问题；传 transcript 时给追问或结束复盘。结果记录到 mock_interview。', {
        job_id: z.string().optional(), resume_id: z.string().optional(), company_type: z.enum(['大厂', '创业公司', '国企央企', '外企']).optional(), round: z.string().optional(),
        transcript: z.string().optional().describe('到目前为止的问答记录'), finish: z.boolean().optional().describe('结束并产出复盘'),
      }, async (args) => wrap(async () => {
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const resume = args.resume_id ? store().getResume(args.resume_id) : undefined;
        const out = await askSkill<Record<string, unknown>>('interview-probe', `${job ? jobDigest(job) : '岗位：未指定'}\n企业性质：${args.company_type ?? '未知'}\n轮次：${args.round ?? '未知'}\n\n简历 / 主张：\n${resume ? resume.row.schema_json : experienceDigest(false)}\n\n已进行的问答：\n${args.transcript ?? '（尚未开始，请给出开场问题）'}\n\n${args.finish ? '请结束并给出面试官视角复盘。' : '请给出下一步追问（JSON）。'}`, { refs: args.company_type ? [args.company_type] : [], temperature: 0.6 });
        const mock = store().createMockInterview({ job_id: args.job_id ?? null, resume_tailored_id: resume?.kind === 'tailored' ? args.resume_id : null, mode: 'probe', company_type: args.company_type ?? null, round: args.round ?? null, turns: args.transcript ? [{ transcript: args.transcript }] : [], report: args.finish ? out : undefined });
        changed('mock_interview');
        return text({ mock_interview_id: mock.id, result: out });
      })()),

      tool('exam_practice', '笔试练习：出题后把题目存档；用户作答后把答案按题号写回；批改后写逐题点评与总结（finish=true）。题目、作答与点评会显示在对话里的「笔试」工作面上。出题由你按岗位与题型生成，参考答案放 reference，不要提前告诉用户。', {
        exam_id: z.string().optional().describe('继续已有练习时传；不传则新建'),
        title: z.string().optional().describe('新建时必填，如「星河科技 产品经理 行测」'),
        company_name: z.string().optional(), job_id: z.string().optional(),
        kind: z.enum(['笔试', '测评', '行测', '编程', '其他']).optional(),
        questions: z.array(z.object({ q: z.string(), kind: z.string().optional(), options: z.array(z.string()).optional(), reference: z.string().optional() })).optional(),
        answers: z.array(z.object({ index: z.number().int().min(0), answer: z.string() })).optional().describe('用户的作答，index 从 0 开始'),
        review: z.array(z.object({ index: z.number().int().min(0), verdict: z.enum(['对', '错', '部分对']), comment: z.string().optional() })).optional(),
        summary: z.string().optional(), finish: z.boolean().optional().describe('批改完成'),
        seen: z.boolean().optional().describe('这些题是用户在真实笔试 / 测评里遇到的（进题库时标为"我见过的"）'),
      }, async (args) => wrap(async () => {
        const exam = store().saveExamPractice({
          id: args.exam_id, title: args.title, company_name: args.company_name, job_id: args.job_id, kind: args.kind,
          questions: args.questions, answers: args.answers, review: args.review, summary: args.summary, finish: args.finish,
        });
        // 题目进题库；批改结果按题记作答（对 100 / 部分对 50 / 错 0）
        const r = repos();
        const all = JSON.parse(exam.questions_json) as Array<{ q: string; kind?: string; reference?: string }>;
        const qKind = exam.kind === '测评' ? 'assessment' as const : 'written' as const;
        const ids = all.map(q => r.upsertQuestion({ content: q.q, kind: qKind, category: q.kind ?? exam.kind ?? null, reference: q.reference ?? null, company_name: exam.company_name, job_id: exam.job_id, source: args.seen ? 'seen' : 'generated', source_ref: `exam:${exam.id}` }).id);
        if (args.review?.length) {
          const answers = JSON.parse(exam.answers_json) as Array<{ index: number; answer: string }>;
          for (const v of args.review) if (ids[v.index]) r.recordAttempt({ question_id: ids[v.index], mode: 'written', answer_text: answers.find(a => a.index === v.index)?.answer ?? null, score: v.verdict === '对' ? 100 : v.verdict === '部分对' ? 50 : 0, feedback: { verdict: v.verdict, comment: v.comment }, job_id: exam.job_id, exam_id: exam.id });
        }
        changed('exam_practice', 'question');
        const questions = JSON.parse(exam.questions_json) as unknown[];
        const answered = (JSON.parse(exam.answers_json) as unknown[]).length;
        return text({ exam_id: exam.id, status: exam.status, questions: questions.length, answered });
      })()),

      tool('resume_ats', '过机筛（ATS）开关与自检：enabled=true 后这份简历导出和投递都用单栏、无照片、标准分区标题的版本；check=true 按当前设置导出后用机器抽文字对照，报告读不出的内容、被打乱的顺序、图标字体等。用户说"过机筛 / 机器筛选 / ATS / 网申系统解析不出来"时用。', {
        resume_id: z.string(), enabled: z.boolean().optional(), check: z.boolean().optional(),
      }, async (args) => wrap(async () => {
        const { isAtsMode, setAtsMode } = await import('../career/export');
        if (!store().getResume(args.resume_id)) return err(`简历不存在：${args.resume_id}`);
        if (args.enabled !== undefined) { setAtsMode(repos(), args.resume_id, args.enabled); changed('kv'); }
        let report: unknown = null;
        if (args.check) {
          progress('resume_ats', '正在导出并做过机筛自检');
          const { runAtsCheck } = await import('../career/ats-check');
          const res = await runAtsCheck({ store: store(), exportPdf: id => exportWithVault(id, 'pdf'), resolve: schema => vault().resolveDeep(schema, { actor: 'resume_export', purpose: `过机筛自检 ${args.resume_id}` }) }, args.resume_id);
          report = { ok: res.ok, score: res.score, issues: res.issues, pages: res.pages };
        }
        return text({ resume_id: args.resume_id, ats_mode: isAtsMode(repos(), args.resume_id), report });
      })()),

      tool('experience_interview', '经历访谈进度（跨对话延续）：六轮普查（education 教育 / course_project 课程项目 / internship 实习 / campus 校园 / competition_personal 比赛与个人项目 / skills 技能证书）每轮状态与下一轮要问的问题；同时给出经历库的缺口（没有确认主张的经历、缺量化结果的主张、待确认数）。每轮访谈开始 / 结束时更新；用户确实没有某类经历（降级问过两次）记 none。', {
        round: z.enum(['education', 'course_project', 'internship', 'campus', 'competition_personal', 'skills']).optional(),
        status: z.enum(['todo', 'in_progress', 'done', 'none']).optional(),
        experience_id: z.string().optional().describe('当前在聊的经历'),
        follow_up_questions: z.array(z.string()).max(5).optional().describe('下一轮要问的 3–5 个事实问题'),
      }, async (args) => wrap(() => {
        const r = repos();
        const cur = r.kvGet<import('@career/core').InterviewState>(core.INTERVIEW_STATE_KEY) ?? { rounds: {} };
        if (args.round || args.status || args.experience_id !== undefined || args.follow_up_questions) {
          const next = { ...cur, rounds: { ...cur.rounds, ...(args.round && args.status ? { [args.round]: args.status } : {}) }, ...(args.round ? { current_round: args.round } : {}), ...(args.experience_id !== undefined ? { current_experience_id: args.experience_id } : {}), ...(args.follow_up_questions ? { follow_up_questions: args.follow_up_questions } : {}), updated_at: new Date().toISOString() };
          r.kvSet(core.INTERVIEW_STATE_KEY, next);
          changed('kv');
          return text(core.interviewProgress(r.experienceTree(), next));
        }
        return text(core.interviewProgress(r.experienceTree(), cur));
      })()),

      tool('question_bank', '题库：总题库 + 用户见过的题 + 按 JD 出的题。按公司 / 来源 / 类型 / 关键词查，或只看没练过 / 得分低于 60 的薄弱题。每题带见过次数与最近 / 最好得分。', {
        kind: z.enum(['interview', 'written', 'assessment']).optional(), source: z.enum(['public', 'seen', 'generated']).optional(),
        company: z.string().optional(), job_id: z.string().optional(), q: z.string().optional(), weak_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(),
      }, async (args) => wrap(() => text({ questions: repos().listQuestions({ ...args, limit: args.limit ?? 30 }).map(q => ({ id: q.id, kind: q.kind, category: q.category, content: q.content, company: q.company_name, title: q.title, source: q.source, seen_count: q.seen_count, attempts: q.attempt_count, last_score: q.last_attempt_score, best_score: q.best_attempt_score, probe_points: JSON.parse(q.probe_points_json) })) }))()),

      tool('question_add', '把用户自己见过的题（真实面试 / 笔试 / 测评里遇到的，或从面经看到的）加进题库。只记用户说的原题，不改写。', {
        questions: z.array(z.object({ content: z.string(), kind: z.enum(['interview', 'written', 'assessment']).optional(), category: z.string().optional(), reference: z.string().optional() })).min(1).max(50),
        company_name: z.string().optional(), title: z.string().optional(), job_id: z.string().optional(),
        source: z.enum(['seen', 'public']).optional().describe('seen = 用户本人遇到；public = 面经 / 公开题'),
      }, async (args) => wrap(() => {
        const r = repos();
        const rows = args.questions.map(q => r.upsertQuestion({ content: q.content, kind: q.kind ?? 'interview', category: q.category ?? null, reference: q.reference ?? null, company_name: args.company_name ?? null, title: args.title ?? null, job_id: args.job_id ?? null, source: args.source ?? 'seen', source_ref: 'user' }));
        changed('question');
        return text({ saved: rows.map(q => ({ id: q.id, content: q.content, seen_count: q.seen_count })) });
      })()),

      tool('question_attempt', '记录用户对某道题的一次作答与评分（模拟面试 / 自练 / 笔试），绑定当时的简历与岗位，用于比较练习进步。评分 0–100，依据写进 feedback（对照 probe_points 与 JD 要求，指出缺的事实，不替用户编造经历）。', {
        question_id: z.string(), answer_text: z.string(), score: z.number().min(0).max(100),
        feedback: z.object({ strengths: z.array(z.string()).optional(), gaps: z.array(z.string()).optional(), rewrite_hint: z.string().optional() }).optional(),
        mode: z.enum(['self', 'mock', 'written', 'real']).optional(), resume_id: z.string().optional(), job_id: z.string().optional(), mock_interview_id: z.string().optional(),
      }, async (args) => wrap(() => {
        const r = repos();
        const resume = args.resume_id ? store().getResume(args.resume_id) : undefined;
        const snapshot = resume ? r.db.get<{ id: string }>('SELECT id FROM resume_snapshot WHERE resume_id=? ORDER BY created_at DESC LIMIT 1', [resume.row.id])?.id ?? null : null;
        const a = r.recordAttempt({ question_id: args.question_id, mode: args.mode ?? 'mock', answer_text: args.answer_text, score: args.score, feedback: args.feedback ?? {}, resume_id: args.resume_id ?? null, resume_snapshot_id: snapshot, job_id: args.job_id ?? null, mock_interview_id: args.mock_interview_id ?? null });
        const history = r.listAttempts(args.question_id).map(x => x.score);
        changed('question');
        return text({ attempt_id: a.id, history, trend: history.length > 1 ? (history.at(-1)! - history[0]!) : null });
      })()),

      tool('interview_project_story', '项目讲述练习打分：结构 / 时长 / 框架 / 数据可信度，只用用户已说过的事实给改进版。', {
        text: z.string().describe('用户的讲述文本或转写'), experience_id: z.string().optional(), job_id: z.string().optional(), target_seconds: z.number().optional(),
      }, async (args) => wrap(async () => {
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const claims = args.experience_id ? repos().listClaims(args.experience_id) : [];
        const out = await askSkill('project-story', `讲述文本：\n${args.text}\n\n对应主张：\n${claims.map(c => `- [${c.status}/${c.attribution}] ${c.text}`).join('\n') || '（无）'}\n\n${job ? jobDigest(job) : ''}\n目标时长：${args.target_seconds ?? 105} 秒`, { temperature: 0.3 });
        return text(out);
      })()),

      tool('interview_retro', '真实面试复盘：逐题诊断、信号判读、受控标签，归档到面试库（证据与推断分开，不预测结果）。', {
        transcript: z.string(), interview_id: z.string().optional(), company_name: z.string().optional(), title: z.string().optional(),
        round: z.enum(['hr', 'first', 'second', 'final', 'group', 'other']).optional(), company_type: z.string().optional(), date: z.string().optional(),
        result: z.enum(['none', 'rejected', 'advanced', 'no_feedback_inferred']).optional(), result_source: z.enum(['none', 'official', 'inferred']).optional(),
      }, async (args) => wrap(async () => {
        const out = await askSkill<Record<string, unknown>>('interview-retro', `本场信息：公司 ${args.company_name ?? '未知'}，岗位 ${args.title ?? '未知'}，轮次 ${args.round ?? '未知'}，企业性质 ${args.company_type ?? '未知'}，结果 ${args.result ?? 'none'}（来源 ${args.result_source ?? 'none'}）\n\n面试记录：\n${args.transcript}\n\n历史面试（最近 5 场）：\n${JSON.stringify(store().listInterviews().slice(0, 5).map(i => ({ company: i.company_name, round: i.round, tags: i.tags_json, result: i.result })))}`, { refs: ['题型诊断', '标签词表'], temperature: 0.2 });
        const s = store();
        const patch = { transcript: args.transcript, retro_json: out, tags_json: out.tags ?? [], result: args.result, result_source: args.result_source, company_name: args.company_name, title: args.title, round: args.round, date: args.date };
        const interview = args.interview_id ? s.updateInterview(args.interview_id, patch as never) : s.createInterview(patch as never);
        // 真实面试里被问到的题进题库（"我见过的"），同一题跨场次累计
        const asked = Array.isArray((out as { questions?: unknown }).questions) ? (out as { questions: Array<{ quote?: string; type?: string; content_tags?: string[] }> }).questions : [];
        const seen = asked.filter(q => q?.quote && q.quote.trim().length >= 4).map(q => repos().upsertQuestion({ content: q.quote!, kind: 'interview', category: q.type ?? null, company_name: args.company_name ?? null, title: args.title ?? null, source: 'seen', source_ref: `interview:${interview.id}`, tags: q.content_tags ?? [] }).id);
        changed('interview', ...(seen.length ? ['question'] : []));
        return text({ interview_id: interview.id, retro: out, questions_saved: seen.length });
      })()),

      tool('interview_predict', '从简历 / 主张预测面试深挖点：靶子类型、预期追问链、露馅风险，写入 probe_prediction。', {
        resume_id: z.string().optional(), job_id: z.string().optional(), company_type: z.string().optional(), round: z.string().optional(),
      }, async (args) => wrap(async () => {
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const resume = args.resume_id ? store().getResume(args.resume_id) : undefined;
        const out = await askSkill<{ predictions?: Array<{ statement: string; target_type?: string; expected_chain?: unknown; risk?: string; claim_id?: string }> }>('probe-predict', `简历 / 主张：\n${resume ? resume.row.schema_json : experienceDigest(false)}\n\n${job ? jobDigest(job) : '岗位：未指定'}\n企业性质：${args.company_type ?? '未知'}，轮次：${args.round ?? '未知'}\n\n输出 JSON：{"predictions":[{"statement":"","target_type":"data|project|industry|method","expected_chain":[],"risk":"high|mid|low","claim_id":""}]}`, { temperature: 0.3 });
        const rows = store().addProbePredictions((out.predictions ?? []).filter(p => p?.statement).map(p => ({ statement: p.statement, target_type: p.target_type ?? 'project', expected_chain: p.expected_chain, risk: p.risk, claim_id: p.claim_id || null, resume_tailored_id: resume?.kind === 'tailored' ? args.resume_id : null })));
        changed('probe_prediction');
        return text({ predictions: rows, raw: out });
      })()),

      // ---------- 方向 / 差距 / Offer ----------
      tool('direction_explore', '结合经历库、偏好与 Web Search，给出 2–3 个可投递方向及依据与不确定性（不替用户选）；写入 direction 表（candidate）。', {
        prefs: z.string().describe('兴趣、不想做的事、工作方式'), constraints: z.string().optional().describe('城市、到岗时间、薪资底线、学历与届别等'),
      }, async (args) => wrap(async () => {
        let hits: unknown[] = [];
        try {
          const provider = await search();
          if (provider) { progress('direction_explore', '正在搜索岗位与行业信息'); hits = await provider.search(`${args.prefs} 岗位 招聘 要求 2026`, { count: 8 }); }
        } catch (error) { console.warn('[career] direction_explore 搜索失败:', error instanceof Error ? error.message : error); }
        const out = await askSkill<{ directions?: Array<{ name: string; [k: string]: unknown }> }>('direction-explore', `经历库：\n${experienceDigest(false)}\n\n偏好：${args.prefs}\n约束：${args.constraints ?? '无'}\n\nWeb Search 结果：\n${JSON.stringify(hits).slice(0, 15_000)}\n\n输出 JSON：{"directions":[{"name":"","rationale":"","evidence":[],"uncertainty":"","typical_jd":""}]}`, { temperature: 0.5 });
        const directions = (out.directions ?? []).filter(d => d?.name).map(d => store().createDirection(d.name, d));
        changed('direction');
        return text({ directions, raw: out, statuses: DIRECTION_STATUSES });
      })()),

      tool('gap_plan', '岗位要求对照经历库分 have / need_evidence / missing 三类，并给出可验收的小任务；写入 gap_plan。', {
        job_id: z.string().optional(), direction_id: z.string().optional(), hours_per_week: z.number().optional(), deadline: z.string().optional(),
      }, async (args) => wrap(async () => {
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const direction = args.direction_id ? store().listDirections().find(d => d.id === args.direction_id) : undefined;
        if (!job && !direction) return err('需要 job_id 或 direction_id');
        const out = await askSkill<{ gaps?: unknown; actions?: unknown }>('gap-plan', `${job ? jobDigest(job) : `方向：${direction!.name}\n${direction!.rationale_json ?? ''}`}\n\n经历库主张与证据：\n${JSON.stringify(repos().experienceTree()).slice(0, 20_000)}\n\n每周可投入：${args.hours_per_week ?? '未知'} 小时；截止：${args.deadline ?? '未知'}\n\n输出 JSON：{"gaps":{"have":[],"need_evidence":[],"missing":[]},"actions":[{"title":"","acceptance":"","hours":0,"due":""}]}`, { temperature: 0.3 });
        const plan = store().createGapPlan({ job_id: args.job_id ?? null, direction_id: args.direction_id ?? null, gaps: out.gaps ?? {}, actions: out.actions ?? [] });
        changed('gap_plan');
        return text({ gap_plan: plan, result: out });
      })()),

      tool('offer_compare', '多个 Offer 放进同一张表拆解比较，列出事实与差异及需用户自行判断的项；不给排序结论。', {
        offer_ids: z.array(z.string()).min(1),
      }, async (args) => wrap(async () => {
        const s = store();
        const offers = args.offer_ids.map(id => s.getOffer(id)).filter((o): o is NonNullable<typeof o> => !!o);
        if (offers.length === 0) return err('没有找到任何 Offer');
        const companies = offers.map(o => (o.company_name ? s.findCompany(o.company_name) : undefined)).filter(Boolean);
        const out = await askSkill('offer-compare', `Offers：\n${JSON.stringify(offers)}\n\n公司调研：\n${JSON.stringify(companies.map(c => ({ name: c!.legal_name, traffic_light: c!.traffic_light })))}\n\n用户经历与偏好：\n${experienceDigest()}\n${JSON.stringify(prefs())}`, { temperature: 0.2 });
        return text(out);
      })()),
    ],
  });
}
