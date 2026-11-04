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
import { basename, isAbsolute, resolve } from 'path';
import type { Repos, LLM, Job, JdParsed, Claim, Experience, Vault, ActionQueueItem, Task, Deadline } from '@career/core';

import { loadCore } from '../career/core-module';
import type { BoardRow } from '../career/job-board';
import { getRepos, careerDataDir, careerExportsDir } from '../career/db';
import { DomainUnavailableError, loadBridges, loadResume } from '../career/domain';
import { exportResumeFile, isExportFormat, EXPORT_FORMATS } from '../career/export';
import { CORRECTABLE_KINDS, correctIntake } from '../career/intake-fix';
import { captureIntake, focus as focusPanel, parseAndStoreJd as parseAndStoreJdShared, type IntakeDeps, type IntakeResult } from '../career/intake';
import { carryoverFor, carryoverPrompt, lastTranscript } from '../career/interview-carry';
import { buildInterviewPrep } from '../career/interview-prep';
import { applicationForInterview, bookInterview, interviewResume } from '../career/interview-link';
import { runInterviewRetro } from '../career/interview-retro-run';
import { getShellLLM } from '../career/llm';
import { MAIL_PRESETS } from '../career/mail/providers';
import { syncAllMailAccounts, syncMailAccount } from '../career/mail/sync';
import { draftMaterial } from '../career/materials';
import { getRunRegistry, type RunRegistry } from '../career/runs';
import { getSearchProvider, type CareerSearchProvider } from '../career/search';
import { setTargetJob } from '../career/targets';
import { loadSkillPrompt } from '../career/skills';
import { CareerStore, DIRECTION_STATUSES } from '../career/store';
import { SEARCH_NOT_CONFIGURED_MESSAGE } from '../career/setup';
import { applyJsonPatch } from '../career/tailor';
import { getVault, vaultForRepos } from '../career/vault';
import { INTAKE_CORE_FIELDS } from '../career/resume-intake';
import { ACCOUNT_FIELDS, reportAccountFetch } from '../career/accounts';
import { applyTaskTitle, gapsHeadline, jobLabel, persistDriveOutcome, type SubmitGate } from '../career/drive-outcome';
import { freezePacket, packetResumeFile, pickResumeForJob } from '../career/packets';
import { formatBrowse, formatSolveCaptcha, formatWaitUser } from '../career/browse-format';
import { BROWSE_SOP } from '../career/browse-sop';
import { acquireBrowserCapability } from '../browser-host/capability-client';
import { broadcast as sseBroadcast } from '../sse';
import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';
import { REVIEW_CARD_KIND, reviewCardId } from '../../shared/careerReviewCard';
import { jobMatchesQuery } from '../../shared/jobSearch';

import { createOfferTools } from './offer-tools';
import { createResumeChainTools } from './resume-chain-tools';

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
  /** 把本地文档读成文字；缺省走对话附件同一套读取（AnyDoc → 内置解析 → 系统 OCR）。 */
  readDocument?: (absPath: string, workspace: string) => Promise<{ ok: boolean; text: string; attempts: string[] }>;
}

const sessionCtx: { sessionId: string; workspace: string } = { sessionId: 'default', workspace: '' };

/** builtin-mcp-registry 的 configure 钩子：冻结当前 Session id 供事件携带，记下工作区供相对路径解析。 */
export function configureCareerTools(_env: Record<string, string>, ctx: { sessionId: string; workspace?: string }): void {
  sessionCtx.sessionId = ctx.sessionId || 'default';
  sessionCtx.workspace = ctx.workspace || '';
}

/** 对话里附件给模型的是工作区相对路径；绝对路径原样用。 */
function workspacePath(path: string): string {
  return isAbsolute(path) || !sessionCtx.workspace ? path : resolve(sessionCtx.workspace, path);
}

async function readDocumentDefault(absPath: string, workspace: string): Promise<{ ok: boolean; text: string; attempts: string[] }> {
  const { convertAttachment, defaultConvertDeps } = await import('../career/attachment-reader');
  const cwd = workspace || careerDataDir();
  return convertAttachment(absPath, cwd, defaultConvertDeps(cwd));
}

// ============= 小工具 =============

const MAX_RESULT_CHARS = 60_000;

/** 伙伴面板会把进度原样展示给用户，所以这里只说在做什么，不露技能 id。 */
const SKILL_PROGRESS: Record<string, string> = {
  'company-research': '正在看这家公司',
  'derivatives': '正在写邮件',
  'direction-explore': '正在帮你看方向',
  'experience-interview': '正在从文档里找你的经历',
  'gap-plan': '正在对照岗位找差距',
  'greeting': '正在写打招呼的话',
  'interview-probe': '正在想下一个追问',
  'interview-questions': '正在准备面试题',
  'interview-retro': '正在复盘这场面试',
  'job-evaluate': '正在评估这个岗位',
  'offer-compare': '正在比较 offer',
  'probe-predict': '正在预测面试追问',
  'project-story': '正在理项目故事',
  'resume-draft': '正在起草简历',
  'resume-import': '正在读你的简历',
  'resume-tailor': '正在改简历',
};

export function skillProgressMessage(skill: string): string {
  return SKILL_PROGRESS[skill] ?? '正在想';
}

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

/** 填表动作不在可执行状态时，给模型一句真实可做的下一步（而不是让它就此放弃）。 */
/** inbox_capture 回给模型的一句收尾：落到哪了就说哪；对不上的让卡片承接，不让用户打字说明。 */
function intakeNote(result: IntakeResult): string {
  if (result.candidates?.length) return '这家有几份在投、信里没写是哪一份，先没归档（没有另建一份）。用 dossier_list 看最近动静能定就带 application_id 再调一次 inbox_capture；定不了就在回复里一句话问他是哪一份，列出岗位名。';
  if (result.item.status === 'new') return '没能自动归档，信留在通知中心。先用 dossier_list 自己对一下能不能确定；确定不了再一句话问他，不要让他解释信的内容。';
  return '已归档，告诉用户落到了哪里即可。';
}

function applyStatusHint(status: string): string {
  switch (status) {
    case 'needs_user': case 'executing': return '；要从接管处继续请用 apply_continue';
    case 'pending_review': return '；等用户在审核卡片里批准后即可执行';
    case 'rejected': return '；用户已拒绝这份，如需重投请重新 apply_prepare（会新建一条投递记录）';
    case 'failed': return '；这份失败且原批准已失效（内容被改过），重新开始请用 apply_prepare';
    case 'done': return '；这份已填完，等它的提交卡被批准后自动提交';
    default: return '';
  }
}

export { applyJsonPatch } from '../career/tailor';

/**
 * job.prefilter_json 是多方共用的对象：`campus` 是校招来源数据（批次 / 行业 / 企业性质，岗位库表格按它筛选，
 * 见 job-board.ts boardMeta），`evaluate` 是 job_evaluate 的硬约束预筛。只替换 evaluate，其余键原样保留。
 */
export function mergeEvaluatePrefilter(existing: string | null | undefined, prefilter: unknown): string | null {
  const base = parseJson<Record<string, unknown>>(existing);
  const next: Record<string, unknown> = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  if (prefilter === null || prefilter === undefined) delete next.evaluate; else next.evaluate = prefilter;
  return Object.keys(next).length ? JSON.stringify(next) : null;
}

// ============= 岗位库表格的筛选维度（与渲染端 jobBoardFilters.ts 同义） =============
// 页面上的「批次 / 行业 / 类型 / 地点 / 进度」多选 + 搜索：jobs_board 用同一套语义，保证助理看到的就是页面那一批。
const EMPLOYMENT_LABELS: Record<string, string> = { campus: '校招', intern: '实习', social: '社招' };
/** 与 job-board.ts 的 DONE 一致：投出去之后的阶段。 */
const BOARD_DONE_STAGES: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired', 'skip']);
export type BoardStage = 'none' | 'active' | 'done';
export interface BoardFacetFilter { q?: string; batch?: string[]; industry?: string[]; type?: string[]; location?: string[]; stage?: BoardStage[] }

export function boardStageOf(row: Pick<BoardRow, 'application'>): BoardStage {
  if (!row.application) return 'none';
  return BOARD_DONE_STAGES.has(row.application.stage) ? 'done' : 'active';
}
export function boardTypeTags(row: Pick<BoardRow, 'job' | 'meta'>): string[] {
  const out: string[] = [];
  const emp = EMPLOYMENT_LABELS[row.job.employment_type ?? ''];
  if (emp) out.push(emp);
  for (const t of row.meta?.type_tags ?? []) if (!out.includes(t)) out.push(t);
  return out;
}
export function boardCities(row: Pick<BoardRow, 'job'>): string[] {
  return (row.job.location ?? '').split(/[/、,，;；|\s]+/).map(c => c.trim()).filter(Boolean);
}
/** 多选维度：同一维度内任一命中即可，维度之间取交集；空数组 = 不限。type 也接受 campus / intern / social。 */
export function filterBoardFacets<R extends Pick<BoardRow, 'job' | 'meta' | 'application'>>(rows: readonly R[], f: BoardFacetFilter): R[] {
  const q = f.q?.trim();
  const types = (f.type ?? []).map(t => EMPLOYMENT_LABELS[t] ?? t);
  const hit = (selected: readonly string[] | undefined, values: string[]) => !selected?.length || selected.some(v => values.includes(v));
  return rows.filter(row => {
    if (q && !jobMatchesQuery(row.job.company_name, row.job.title, q)) return false;
    return hit(f.batch, row.meta?.batch ? [row.meta.batch] : [])
      && hit(f.industry, row.meta?.industry ? [row.meta.industry] : [])
      && hit(types, boardTypeTags(row))
      && hit(f.location, boardCities(row))
      && hit(f.stage, [boardStageOf(row)]);
  });
}

// ============= 截止事件列表 =============
const pad2 = (n: number) => String(n).padStart(2, '0');
/** ISO 时间在本机时区的日期（日历按本地日期分格）。 */
function localDay(iso: string): string { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export type DeadlineListStatus = 'undone' | 'open' | 'done' | 'missed' | 'cancelled' | 'all';
export interface DeadlineListFilter { from?: string; to?: string; kind?: string; status?: DeadlineListStatus }

/**
 * 截止事件筛选：from / to 可给日期（YYYY-MM-DD，按本地日期含当天）或完整 ISO 时间。
 * 缺省 = 未完成（open / missed）且 30 天内到期的全部，含已过期没处理的。
 */
export function selectDeadlines(all: readonly Deadline[], f: DeadlineListFilter, nowIso = new Date().toISOString()): Deadline[] {
  const status = f.status ?? 'undone';
  const nowMs = Date.parse(nowIso);
  const to = f.to ?? (f.from ? undefined : new Date(nowMs + 30 * 86_400_000).toISOString());
  // 时间未知的事件不按区间过滤：它们需要用户去确认时间，始终列出（排在最后）。
  const after = (due: string, bound: string) => (DATE_ONLY.test(bound) ? localDay(due) >= bound : Date.parse(due) >= Date.parse(bound));
  const before = (due: string, bound: string) => (DATE_ONLY.test(bound) ? localDay(due) <= bound : Date.parse(due) <= Date.parse(bound));
  return all.filter(d => {
    if (status === 'undone' ? !(d.status === 'open' || d.status === 'missed') : status !== 'all' && d.status !== status) return false;
    if (f.kind && d.kind !== f.kind) return false;
    if (!d.due_at) return true;
    if (f.from && !after(d.due_at, f.from)) return false;
    if (to && !before(d.due_at, to)) return false;
    return true;
  }).sort((a, b) => (Number(a.due_at === null) - Number(b.due_at === null)) || (a.due_at ?? '').localeCompare(b.due_at ?? ''));
}

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
  /**
   * 待你批准的动作（提交 / 发送）→ 对话内审核卡片：和其他流程卡片一样落库并锚定到这次工具调用，
   * 每个动作一张（id 稳定），不会互相覆盖，刷新后读回。data 是卡片里要展示的内容（如提交前的审阅清单）。
   */
  const review = (actionIds: string[], kind: string, summary: string, data: Record<string, unknown> = {}) =>
    card(reviewCardId(actionIds), REVIEW_CARD_KIND, summary, { ...data, action_ids: actionIds, kind, summary });
  /** 卡片已经没用了（如缺项已补齐、填表重新检查通过）：折叠成"已完成"。 */
  const completeCard = (id: string) => {
    let row: ReturnType<Repos['getChatCard']>;
    try { row = repos().getChatCard(id); } catch { return; }
    if (!row || row.state !== 'pending') return;
    try { repos().setChatCardState(id, 'completed'); } catch { return; }
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data_json) as Record<string, unknown>; } catch { /* ignore */ }
    broadcast('career:card', { sessionId: row.session_id, card: { id, kind: row.kind, title: row.title, data, createdAt: row.created_at, sessionId: row.session_id, toolUseId: row.tool_use_id, state: 'completed' } });
  };
  const profileFieldSet = new Set<string>(core.PROFILE_FIELDS.map(f => f.field));
  /** 填表需要用户补充 / 确认的项 → needs_user / drafts 卡片。资料类字段写私密库，其余写答案库。 */
  const emitDriveCards = (actionId: string, summary: Record<string, unknown> | undefined, gate?: SubmitGate, job?: string) => {
    const asPlans = (v: unknown) => (Array.isArray(v) ? v as Array<{ fieldId?: string; label?: string; key?: string; note?: string; value?: string }> : []);
    const needs = asPlans(summary?.needsUser).filter(p => typeof p.label === 'string' && p.label);
    const drafts = asPlans(summary?.drafts).filter(p => typeof p.label === 'string' && p.label);
    // 上传类格子（照片 / 作品集）不能在卡片里打字补，只能去页面上传
    const fileLabels = new Set((Array.isArray(summary?.fields) ? summary.fields as Array<{ label?: string; type?: string }> : []).filter(f => f.type === 'file' && f.label).map(f => f.label as string));
    /** 缺项能不能在卡片里直接填：资料类字段写私密库，其余写答案库。 */
    const inputFor = (label: string) => {
      const p = needs.find(n => n.label === label);
      if (!p || fileLabels.has(label)) return null;
      const def = p.key && profileFieldSet.has(p.key) ? core.PROFILE_FIELDS.find(f => f.field === p.key) : undefined;
      return { vault_field: def?.field ?? null, sensitive: def?.sensitive ?? false, note: p.note ?? null };
    };
    // 停在提交前但没过提交门槛：一张"还差 N 项要你补"的交接卡，逐项列字段名和原因；能在卡片里填的项直接带输入框。
    // 缺项只出这一张——不再另出一张内容重复的"需要你来填"卡
    if (gate && !gate.ready) {
      card(`apply_gaps:${actionId}`, 'apply_gaps', `「${job ?? '这个岗位'}」${gapsHeadline(gate.gaps)}`, {
        action_id: actionId, job: job ?? null,
        required_filled: gate.requiredFilled, required_total: gate.requiredTotal,
        items: gate.gaps.slice(0, 30).map(g => ({ label: g.label, reason: g.reason, status: g.status, required: g.required, input: inputFor(g.label) })),
      });
      completeCard(`needs_user:${actionId}`);
    } else {
      if (gate?.ready) completeCard(`apply_gaps:${actionId}`);
      const fillable = needs.filter(p => !fileLabels.has(p.label!));
      if (fillable.length) {
        card(`needs_user:${actionId}`, 'needs_user', `网申表里有 ${fillable.length} 项需要你来填`, {
          action_id: actionId,
          items: fillable.slice(0, 20).map(p => ({ label: p.label, ...inputFor(p.label!) })),
        });
      }
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
    progress(skill, skillProgressMessage(skill));
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
  /** 新写进经历库的主张一律出确认卡：没确认的不会进简历，用户得看得见。 */
  const claimsCard = (experience: Pick<Experience, 'id' | 'title'>, claims: Claim[]): void => {
    if (!claims.length) return;
    card(`claims:${experience.id}`, 'claims_confirm', `确认「${experience.title}」里的 ${claims.length} 条说法`, {
      experience_id: experience.id, experience_title: experience.title,
      claims: claims.map(c => ({ id: c.id, text: c.text, result_metric: c.result_metric ?? null, attribution: c.attribution ?? null })),
    });
  };
  /** 网申核心基本信息还缺哪些：缺就在对话里出一张「补齐基本信息」卡（同 id 覆盖），返回缺的字段。 */
  const vaultMissingCard = (): string[] => {
    const have = new Set(vault().status().profile.filled.map(f => f.field));
    const missing = INTAKE_CORE_FIELDS.filter(f => !have.has(f));
    if (missing.length) {
      card('vault_missing', 'vault_missing', '补齐网申基本信息', {
        fields: missing.map(field => { const def = core.PROFILE_FIELDS.find(f => f.field === field); return { field, label: def?.label ?? field, hint: def?.hint ?? null, sensitive: def?.sensitive ?? false }; }),
      });
    }
    return missing;
  };
  /** 用户没说教育背景时，用私密库里的学校 / 专业 / 学历 / 毕业时间（写占位符，导出时才解成明文）。 */
  const vaultEducation = (filled: ReadonlySet<string>): Array<Record<string, string>> => {
    if (!filled.has('school')) return [];
    const ph = (field: string) => (filled.has(field) ? core.vaultPlaceholder('profile', '', field) : '');
    return [{ school: ph('school'), major: ph('major'), degree: ph('degree'), end: ph('graduation') }];
  };
  const jobDigest = (job: Job): string => `公司：${job.company_name ?? '未知'}\n岗位：${job.title}\n地点：${job.location ?? '未知'}\n${job.jd_parsed_json ? `JdParsed：${job.jd_parsed_json}` : `JD 原文：${job.jd_raw ?? '（无）'}`}`;
  const prefs = (): unknown => repos().kvGet('preferences') ?? {};

  /** 共享服务（收件箱 / 复盘 / 素材 / 邮箱）的依赖。 */
  const intakeDeps = (): IntakeDeps => ({ repos: repos(), core, llm: llm(), broadcast, sessionId });
  const focus = (hint: Parameters<typeof focusPanel>[1]) => focusPanel({ broadcast, sessionId }, hint);
  const parseAndStoreJd = (input: { jd_raw?: string; url?: string; job_id?: string; company_name?: string; title?: string; source_platform?: string }): Promise<{ job: Job; parsed: JdParsed }> =>
    parseAndStoreJdShared(intakeDeps(), input);

  /** 模型浏览：调 Global browse 操作，取结果行；用户接管中 / 浏览器报错都转成明确的中文错误。 */
  const browseCall = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let result: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      await browserRun({ op: 'browse', ...body }, ev => {
        if (ev.type === 'result' && ev.op === 'browse') result = ev;
        if (ev.type === 'error') error = String(ev.error ?? '浏览器报错');
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 409/.test(msg)) throw new Error('用户正在接管浏览器：等用户在现场处理完并交回后再继续，不要重复调用。');
      throw e;
    }
    if (error) throw new Error(error);
    if (!result) throw new Error('浏览器没有返回结果');
    return result;
  };

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
    if (!response.ok || !response.body) throw new Error(`浏览器没有接下这次填表（HTTP ${response.status}）`);
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

  /** 简历在文案里的叫法：写具体名字（主简历名 / 某岗位的定制版），不写"指定"这类内部原因。 */
  const resumeLabel = (resumeId: string): string => {
    const found = store().getResume(resumeId);
    if (!found) return '';
    if (found.kind === 'master') return `「${found.row.name}」`;
    const master = store().getResume(found.row.master_id);
    const base = master?.kind === 'master' ? `「${master.row.name}」` : '';
    const forJob = found.row.job_id ? repos().getJob(found.row.job_id) : undefined;
    return `${base}为「${jobLabel(forJob)}」定制的版本`;
  };

  const packetDeps = () => ({ repos: repos(), store: store(), exportPdf: (id: string) => exportWithVault(id, 'pdf'), exportsDir: exportsDir() });


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
  async function runDrive(action: ActionQueueItem, mode: 'start' | 'continue', opts: { claimed?: boolean } = {}): Promise<CallToolResult> {
    const r = repos();
    const payload = parseJson<Record<string, unknown>>(action.payload_json) ?? {};
    const runId = `run_${action.id}`;
    const registry = runs();
    let task = mode === 'continue' ? r.db.get<Task>('SELECT * FROM task WHERE kind=? AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1', ['apply', `%"action_id":"${action.id}"%`]) : undefined;
    if (!task) task = r.createTask({ title: applyTaskTitle(typeof payload.job_id === 'string' ? r.getJob(payload.job_id) : undefined), kind: 'apply', sessionId: sessionId(), payload: { ...payload, action_id: action.id } });
    const taskId = task.id;
    r.updateTask(taskId, { status: 'running' });
    if (mode === 'continue') {
      for (const h of r.openHandoffs()) if (h.action_id === action.id) r.closeHandoff(h.id, '继续填写');
      r.setActionStatus(action.id, 'executing');
    } else if (!opts.claimed) {
      // 认领：approved → executing 原子切换并核对批准时的内容哈希；后台批量已经拿走 / 批准后内容变了都会失败
      const claim = r.claimAction(action.id);
      if (!claim.ok) {
        r.updateTask(taskId, { status: 'failed' });
        changed('task', 'action_queue');
        return err(claim.reason === 'content_changed' ? '这份网申在批准之后内容有变化，已退回待审核，请让用户重新确认后再执行' : `动作已不是待执行状态（${claim.action?.status ?? '不存在'}），可能后台批量投递正在处理它`);
      }
    }
    if (action.application_id) { try { r.transition(action.application_id, 'pending', mode === 'start' ? '开始填写网申' : '接着填写网申'); } catch { /* 阶段已在执行态 */ } }
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
      const file = await packetResumeFile(r, payload, resumeFileFor, { resolveText: t => vault().resolve(t, { actor: 'resume_export', purpose: '简历附件文件名' }) });
      if (file.error) return failRun(file.error);
      const resumePath = file.path;
      // 续跑：上次 needs_user 的标签交给引擎，用户在接管期间自己填好的值会被学进答案库
      const prevSummary = mode === 'continue' ? parseJson<{ needsUser?: Array<{ label?: string }> }>(action.result_json) : undefined;
      const learnFrom = (prevSummary?.needsUser ?? []).map(p => p.label).filter((l): l is string => typeof l === 'string' && !!l);
      await browserRun({ op: 'drive', caller: 'chat', runId, actionId: action.id, applicationId: action.application_id, payload, ...(mode === 'start' && typeof payload.url === 'string' ? { url: payload.url } : {}), ...(mode === 'continue' && typeof payload.url === 'string' ? { siteUrl: payload.url } : {}), ...(resumePath ? { resumePath } : {}), ...(learnFrom.length ? { learnFrom } : {}) }, (ev) => {
        events.push(ev);
        if (ev.type === 'progress') progress('fill_form', String(ev.message ?? ''), { runId, taskId, progress: ev.progress });
      });
    } catch (error) {
      // 和批量执行器同一套分诊：保留错误名（code），浏览器被占用 / 接管 / 宿主停机不算这份网申失败
      events.push({ type: 'error', status: 500, error: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.name !== 'Error' ? { code: error.name } : {}) });
    }
    const outcome = persistDriveOutcome({ repos: r, action, taskId, events, changed, review, mode });
    if (outcome.kind === 'transient') {
      // 不是这份网申的失败：放回队列（start）或保持 needs_user（continue），给模型可执行的下一步，绝不判死
      registry.finish(runId);
      const hint = outcome.code === 'BROWSER_CONTROL_HUMAN'
        ? `用户正在接管浏览器，这次调用没有执行（这份网申没有损坏，也不用重新批准）。等用户在产品里点「交回」后调用 apply_continue(${action.id}) 从当前页继续。`
        : outcome.code === 'BROWSER_BUSY'
          ? `浏览器正在被另一处使用（如后台批量投递）。这份已放回队列：可以等批量顺带处理，或让用户暂停批量后用 apply_run(${action.id}) 再执行。`
          : `这次没跑成是暂时性问题（${outcome.message}），这份已放回队列：可直接用 apply_run(${action.id}) 重试，或等后台批量顺带处理；不要把这份判为失败。`;
      return err(hint);
    }
    const jobName = jobLabel(typeof payload.job_id === 'string' ? r.getJob(payload.job_id) : undefined);
    if (outcome.kind !== 'failed') emitDriveCards(action.id, outcome.summary, outcome.gate, jobName);
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
      if (outcome.gate) {
        // 停在提交前但没过门槛：不是"填好了"，提交也没有入队
        const g = outcome.gate;
        return text({ runId, taskId, state: 'needs_user', action_id: action.id, handoffId: outcome.handoffId, reason: outcome.reason, gaps: g.gaps, requiredFilled: g.requiredFilled, requiredTotal: g.requiredTotal, summary: outcome.summary,
          note: `还没填完，提交没有入队：${gapsHeadline(g.gaps)}${g.requiredTotal !== null ? `（必填 ${g.requiredFilled}/${g.requiredTotal}）` : ''}。对话里有一张卡片逐项列出了这些字段和原因。把缺的项用人话告诉用户（这时还没填完，别跟用户说已经填完了；不要提工具名或动作 id）；用户补好后会发来消息，届时调用 apply_continue(action_id) 从当前页继续并重新检查。` });
      }
      return text({ runId, taskId, state: 'paused', action_id: action.id, handoffId: outcome.handoffId, reason: outcome.reason, userAction: outcome.userAction, summary: outcome.summary, note: '已暂停：请把 userAction 原话告诉用户；用户在浏览器里处理完并点"交回"后，调用 apply_continue(action_id) 从当前页继续。' });
    }
    registry.finish(runId);
    return text({ runId, taskId, state: 'done', submitActionId: outcome.submitActionId, autoApproved: outcome.autoApproved ?? null, decision: outcome.decision,
      requiredFilled: outcome.gate.requiredFilled, requiredTotal: outcome.gate.requiredTotal, summary: outcome.summary,
      note: outcome.autoApproved
        ? `${outcome.headline}；${outcome.decision}，产品会在几秒内自动点提交，结果会更新到这份投递。`
        : `${outcome.headline}，还没有提交。对话里有一张提交卡片带审阅清单（${outcome.decision ?? '需要用户确认'}）；用户看过批准后，产品替用户点提交。告诉用户去卡片里看一遍，不要提工具名或动作 id。` });
  }

  return createSdkMcpServer({
    name: 'career',
    version: '1.0.0',
    instructions: '求职助理的数据与执行工具。读写一律走这些工具；submit / send_greeting / answer_open_q / send_mail 进入待审核队列，由用户批准后执行（网申提交例外：用户开了 auto 模式，或同一张表已自学习免审时会直接提交）；send_greeting / answer_open_q 批准后不会自动发出，而是转为 needs_user 交给用户本人去平台发送。',
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
        vaultMissingCard();
        return text({
          ...status,
          placeholders: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}', email: '{{vault:profile.email}}' },
          note: '简历 / 网申草稿里需要这些信息时直接写占位符，导出或填表时会在产品内自动替换成真实值；你拿不到也不需要真实值。',
        });
      })),
      // ---------- 今日 / 收件箱 / 截止 ----------
      tool('account_fetch_report', '用户在「基本资料」绑定账号（领英 / 脉脉 / GitHub / 个人网站 / 学信网）后会让你抓一次信息。抓完必须调用它回报结果：ok 抓到了；login_expired 打开后是登录页、用户没登录或登录已失效；failed 其他原因没抓到。页面据此显示上次抓取时间，登录过期时提醒用户重新绑定。', {
        field: z.enum(ACCOUNT_FIELDS),
        status: z.enum(['ok', 'login_expired', 'failed']),
        note: z.string().optional().describe('一句话说明：抓到了什么，或为什么没抓到'),
      }, async (args) => wrap(() => {
        const state = reportAccountFetch(repos(), args.field, args.status, args.note ?? null);
        changed('account_fetch');
        return text({ state });
      })()),
      tool('today_queue', '今天必须做的事（已排序：今天到期 → 待你批准 → 需要你本人 → 今日面试 → 新收件 → 可关闭的静默线 → 近三天到期 → 已过期没打勾的）+ 等待中的投递数。今日页上都列着，回复只说最急的一件、其余报个数，不逐条复述。只含 3 天内的时间点（条目带 deadline_id）；更远的日程用 deadline_list。', {}, wrap(() => text(repos().today()))),

      tool('inbox_capture', '把用户丢进来的任何内容（JD、面试邀请、测评 / 笔试通知、拒信、Offer、内推码、截止提醒）归档成结构化对象：自动建岗位 / 面试 / 截止事件 / 关闭投递 / Offer，并关联到卷宗。', {
        text: z.string().describe('原文'), source: z.enum(['paste', 'file', 'url', 'chat']).optional(), application_id: z.string().optional().describe('用户已明确归属的投递'),
      }, async (args) => wrap(async () => {
        progress('inbox_capture', '正在归档收件箱内容');
        const result = await captureIntake(intakeDeps(), { text: args.text, source: args.source ?? 'chat', application_id: args.application_id ?? null });
        return text({ item_id: result.item.id, kind: result.item.kind, status: result.item.status, created: result.created, summary: result.summary, urgency: result.triage?.urgency ?? null, candidates: result.candidates ?? [], note: intakeNote(result) });
      })()),

      tool('inbox_correct', '一封信读错了时更正：用户说「那封是面试 / 那不是笔试 / 那是广告」就用它（inbox_id 从 inbox_list 找）。撤掉这封信推的阶段和它建的时间点，带着正确类型重抽字段（如面试时间）再落库；ignored = 和求职无关，放进已忽略。用户只说了正确类型就够，不要追问细节。', {
        inbox_id: z.string(), kind: z.enum(CORRECTABLE_KINDS),
      }, async (args) => wrap(async () => {
        const result = await correctIntake(intakeDeps(), args.inbox_id, args.kind);
        changed('inbox_item', 'application', 'application_history', 'deadline', 'dossier_note', 'interview');
        return text({ item_id: result.item.id, kind: args.kind, created: result.created, summary: result.summary });
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

      tool('deadline_done', '把一个时间点标记为已完成 / 取消。过了时间的笔试 / 测评（today_queue 条目带 ask=attendance）：用户说考了 / 做了用 done，说没去 / 没做用 skipped，会记进卷宗。过了时间的面试不问「去了吗」，走复盘（interview_retro）。', { deadline_id: z.string(), status: z.enum(['done', 'cancelled', 'missed', 'skipped']).optional() }, async (args) => wrap(() => {
        const r = repos();
        const status = args.status ?? 'done';
        const current = r.getDeadline(args.deadline_id);
        const answering = !!current && (status === 'done' || status === 'skipped') && core.asksAttendance(current, new Date().toISOString());
        const deadline = answering ? r.answerAttendance(args.deadline_id, status === 'done') : r.setDeadlineStatus(args.deadline_id, status);
        if (answering) changed('dossier_note');
        changed('deadline');
        return text({ deadline });
      })()),

      tool('deadline_list', '列出时间点（日历上的测评 / 笔试 / 面试 / 截止…），每条带 deadline_id、所属公司与投递。缺省 = 30 天内到期 + 已过期还没处理的；用户在招聘概览选了某天（refs.date）就传 from=to=那天。改期 / 改标题用 deadline_update，完成用 deadline_done。', {
        from: z.string().optional().describe('起始：YYYY-MM-DD（含当天）或 ISO 时间'), to: z.string().optional().describe('截止：YYYY-MM-DD（含当天）或 ISO 时间'),
        kind: z.enum(['assessment', 'written_test', 'interview', 'application_deadline', 'offer_reply', 'referral_expiry', 'other']).optional(),
        status: z.enum(['undone', 'open', 'done', 'missed', 'cancelled', 'all']).optional().describe('缺省 undone = 未完成（open + 已过期未处理的 missed）'),
      }, async (args) => wrap(() => {
        for (const bound of [args.from, args.to]) if (bound && Number.isNaN(Date.parse(bound))) return err(`不是可解析的时间：${bound}`);
        const r = repos();
        const now = new Date().toISOString();
        const jobs = new Map<string, Job | undefined>();
        const jobOf = (id: string | null | undefined) => { if (!id) return undefined; if (!jobs.has(id)) jobs.set(id, r.getJob(id)); return jobs.get(id); };
        const list = selectDeadlines(r.listDeadlines(), args, now).map(d => {
          const job = jobOf(d.job_id) ?? jobOf(d.application_id ? r.getApplication(d.application_id)?.job_id : null);
          return { id: d.id, title: d.title, kind: d.kind, due_at: d.due_at, status: d.status, overdue: !!d.due_at && (d.status === 'open' || d.status === 'missed') && d.due_at < now, company: job?.company_name ?? null, job_title: job?.title ?? null, application_id: d.application_id, job_id: d.job_id ?? job?.id ?? null, note: d.note, url: d.url };
        });
        return text({ deadlines: list, total: list.length, range: { from: args.from ?? null, to: args.to ?? (args.from ? null : '30 天内'), status: args.status ?? 'undone', kind: args.kind ?? null } });
      })()),

      tool('deadline_update', '改一个时间点：改期（due_at）、改标题 / 类型 / 备注。用户说"笔试改到周五 / 这个时间记错了"时用；deadline_id 来自 deadline_list 或 today_queue 条目的 deadline_id。已过期的改到将来会重新变回未完成。', {
        deadline_id: z.string(), due_at: z.string().optional().describe('ISO 时间，如 2026-10-05T14:00:00+08:00'), title: z.string().optional(), note: z.string().optional(),
        kind: z.enum(['assessment', 'written_test', 'interview', 'application_deadline', 'offer_reply', 'referral_expiry', 'other']).optional(),
      }, async (args) => wrap(() => {
        const r = repos();
        const current = r.getDeadline(args.deadline_id);
        if (!current) return err(`截止事件不存在：${args.deadline_id}`);
        if (args.due_at !== undefined && Number.isNaN(Date.parse(args.due_at))) return err('due_at 不是可解析的时间');
        const patch: Record<string, unknown> = {};
        if (args.due_at !== undefined) patch.due_at = new Date(args.due_at).toISOString();
        if (args.title !== undefined && args.title.trim()) patch.title = args.title.trim();
        if (args.note !== undefined) patch.note = args.note || null;
        if (args.kind !== undefined) patch.kind = args.kind;
        if (!Object.keys(patch).length) return err('没有要改的字段：due_at / title / note / kind 至少给一个');
        if (typeof patch.due_at === 'string' && current.status === 'missed' && Date.parse(patch.due_at) > Date.now()) patch.status = 'open';
        r.db.update('deadline', current.id, { ...patch, updated_at: new Date().toISOString() });
        if (current.interview_id && typeof patch.due_at === 'string') r.rescheduleInterview(current.interview_id, patch.due_at);
        changed('deadline', ...(current.interview_id ? ['interview'] : []));
        return text({ deadline: r.getDeadline(current.id) });
      })()),

      // ---------- 卷宗 ----------
      tool('dossier_list', '所有投递的档案摘要（公司、岗位、阶段、静默天数、下一个截止、面试次数）。', {}, wrap(() => text({ dossiers: store().dossierSummaries() }))),

      tool('dossier_get', '用户问「某家怎样了」或面试前一键摊开（对话里会自动出一张这份申请的对象卡，回复不必复述进度）：这条投递用的哪版简历、开放题填了什么、说过什么、公司调研、预测追问、所有邮件与时间点。按 application_id / job_id / 公司名任一查找。', {
        application_id: z.string().optional(), job_id: z.string().optional(), company_name: z.string().optional(),
      }, async (args) => wrap(() => {
        let appId = args.application_id;
        if (!appId && args.job_id) appId = repos().listApplications().find(a => a.job_id === args.job_id)?.id;
        if (!appId && args.company_name) {
          const hits = repos().findOpenApplicationsByCompany(args.company_name);
          if (hits.length > 1) return err(`${args.company_name} 有 ${hits.length} 条投递：${hits.map(h => `${h.job.title}（${h.id}）`).join('、')}。用户问的是整家公司就逐条 dossier_get 一起答；只有确实要分开时才把这几份列成选项一次问完`);
          appId = hits[0]?.id;
        }
        if (!appId) return err('没有找到对应的投递；可以先用 dossier_list 看看');
        const dossier = store().dossier(appId);
        if (!dossier) return err(`投递不存在：${appId}`);
        focus({ surface: 'dossier', application_id: appId });
        // 问「某家怎样了」：对话里出一张申请对象卡（规范 §5.8），同一家再问会覆盖同一张
        const job = dossier.job as { company_name?: string | null; company_id?: string | null; title?: string } | undefined;
        card(`application:${appId}`, 'application', `${job?.company_name ?? ''} ${job?.title ?? ''}`.trim() || '这份申请', { application_id: appId, company: core.companyMarkOf(job?.company_name, job?.company_id ?? null) });
        return text(dossier);
      })()),

      tool('dossier_note_add', '往卷宗里记一条：对这家公司说过的话（said）、听到的信息（heard）、联系人 / 内推人、备注。面试复盘里的关键表述务必记 said，保证下一轮前后一致。', {
        application_id: z.string(), kind: z.enum(['note', 'said', 'heard', 'contact', 'referral']).optional(), round: z.string().optional(), content: z.string(),
      }, async (args) => wrap(() => {
        const note = repos().addDossierNote({ application_id: args.application_id, kind: args.kind ?? 'note', round: args.round ?? null, content: args.content });
        changed('dossier_note');
        return text({ note });
      })()),

      tool('application_correct', '更正一次误判：用户说之前告诉错了阶段（读错的是某封信时优先用 inbox_correct，它连时间点一起改）。撤掉这份投递最近一次推进（连同自动补的中间步骤），再推进到用户说的正确阶段；漏斗里不留误判，卷宗记一笔更正。只在用户明确指出错了时用；正常推进用 application_set_stage。', {
        application_id: z.string(), stage: z.enum(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded']).describe('用户说的正确阶段'), note: z.string().optional().describe('谁说错了、正确情况是什么；用户只说了「不对，是面试」就不用填，不要为这个追问'),
      }, async (args) => wrap(() => {
        const r = repos();
        const note = args.note?.trim() || `用户说应为「${args.stage}」`;
        const back = r.undoLastStage(args.application_id, note);
        const application = back.stage === args.stage ? back : r.jumpTo(args.application_id, args.stage, `更正：${note}`);
        changed('application', 'application_history', 'dossier_note');
        focus({ surface: 'dossier', application_id: application.id });
        return text({ application, note: application.stage === 'interview' ? '已改回面试。若那封邮件里有面试时间，用 inbox_capture 带上 application_id 重新归档，面试和期限会建上。' : '已更正。' });
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
      tool('month_review', '用户想复盘、问投递效果、说「投了这么多没回音 / 是不是我不行」时用：在对话里放一张「我的求职月」卡（本月投出、回音、面试、Offer 四个数），点一下就到漏斗那页看全。回复一两句即可，不在对话里展开分析。面试复盘不是它，用 interview_retro。', {}, wrap(() => {
        const board = repos().monthBoard({ tzOffsetMinutes: -new Date().getTimezoneOffset() });
        card(`month-review:${board.month.key}`, 'month_review', `${board.month.month} 月的求职`, { month: board.month.key, counts: board.counts, prev: board.prev, since_total: board.since_total });
        return text({ month: board.month.key, counts: board.counts, note: '卡片已在对话里，点开就是「我的求职月」；回复一两句。' });
      })),

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
          progress('mail_compose', '正在备好简历附件');
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

      tool('experience_add', '写入一段经历到经历库，并附带若干主张（claims，状态一律 pending，需用户确认后才能进简历）。接着补一段已有的经历时传 experience_id，主张加到原经历上，不另建。', {
        experience_id: z.string().optional().describe('接着补已有经历时传；缺省新建'),
        title: z.string().describe('经历标题'), role: z.string().optional(), org: z.string().optional(),
        start_date: z.string().optional().describe('YYYY-MM'), end_date: z.string().optional().describe('YYYY-MM，在职/进行中留空'),
        type: z.enum(['dev', 'data', 'pm', 'ops', 'design', 'marketing', 'finance', 'education', 'admin', 'other']).optional(),
        summary: z.string().optional(), redacted: z.boolean().optional().describe('用户只提供了脱敏摘要'),
        claims: z.array(z.object({ text: z.string(), attribution: z.enum(['self', 'team', 'unknown']).optional(), result_metric: z.string().optional() })).optional(),
      }, async (args) => wrap(() => {
        const r = repos();
        const fields = { title: args.title, role: args.role, org: args.org, start_date: args.start_date, end_date: args.end_date, type: args.type, summary: args.summary, redacted: args.redacted === undefined ? undefined : args.redacted ? 1 : 0 };
        let experience: Experience;
        if (args.experience_id) {
          const existing = r.getExperience(args.experience_id);
          if (!existing) return err(`经历不存在：${args.experience_id}；先用 experience_list 找到要补的经历`);
          r.updateExperience(existing.id, fields);
          experience = r.getExperience(existing.id)!;
        } else {
          experience = r.createExperience({ ...fields, role: args.role ?? null, org: args.org ?? null, start_date: args.start_date ?? null, end_date: args.end_date ?? null, summary: args.summary ?? null, redacted: args.redacted ? 1 : 0 });
        }
        const claims = (args.claims ?? []).map(c => r.addClaim({ experience_id: experience.id, text: c.text, attribution: c.attribution, result_metric: c.result_metric ?? null, created_from: 'interview' }));
        changed('experience', 'claim');
        claimsCard(experience, claims);
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

      tool('ingest_document', '读取本地文档（实习证明、项目报告、作品说明等），抽取主张写入经历库（pending）并附 doc_fragment 证据，对话里出确认卡。用户自己的简历不要用它，用 resume_import（会一并补基本信息、按段落建经历、一键生成主简历）。', {
        path: z.string().describe('本地文件路径：绝对路径，或对话附件给出的工作区相对路径'), experience_id: z.string().optional().describe('归属的经历；缺省新建一条以文件名命名的经历'),
      }, async (args) => wrap(async () => {
        const abs = workspacePath(args.path);
        if (!existsSync(abs)) return err(`找不到文件：${args.path}`);
        progress('ingest_document', `正在读取文档 ${basename(abs)}`);
        const doc = await (deps.readDocument ?? readDocumentDefault)(abs, sessionCtx.workspace);
        const markdown = doc.ok ? doc.text : '';
        if (!markdown.trim()) return err(`没读出文字。依次尝试过：${doc.attempts.join('；') || '无'}。请让用户换成可复制文字的 PDF / Word，或直接截图发过来。`);
        const out = await askSkill<{ claims?: Array<{ text: string; attribution?: 'self' | 'team' | 'unknown'; result_metric?: string; excerpt?: string }> }>(
          'experience-interview', `以下是用户上传的文档《${basename(abs)}》读出的文字。请只抽取可核验的事实主张，输出 JSON：{"claims":[{"text":"","attribution":"self|team|unknown","result_metric":"","excerpt":"原文片段"}]}。\n\n${markdown.slice(0, 30_000)}`, { temperature: 0.1 });
        const r = repos();
        const experienceId = args.experience_id ?? r.createExperience({ title: basename(abs), type: 'other', summary: '由文档导入' }).id;
        const claims = (out.claims ?? []).map(c => {
          const claim = r.addClaim({ experience_id: experienceId, text: c.text, attribution: c.attribution, result_metric: c.result_metric || null, created_from: 'doc' });
          r.addEvidence({ claim_id: claim.id, kind: 'doc_fragment', locator: abs, excerpt: c.excerpt ?? null, strength: 'mid' });
          return claim;
        });
        changed('experience', 'claim', 'evidence');
        claimsCard(r.getExperience(experienceId)!, claims);
        return text({ experience_id: experienceId, claims, note: '主张均为 pending；对话里已出确认卡，用户勾一下即可，不要在对话里逐条问。' });
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
        claimsCard(r.getExperience(experienceId)!, imported.claims);
        return text({ experience_id: experienceId, claims: imported.claims, evidence_count: imported.evidence.length, notes: result.notes, dropped: result.dropped });
      })()),

      // ---------- 岗位 ----------
      tool('jd_parse', '九类 JD 分析 + 关键词三分类，结果存入 job.jd_parsed_json；没有 job_id 时新建岗位。', {
        jd_raw: z.string().optional(), url: z.string().optional(), job_id: z.string().optional(), company_name: z.string().optional(), title: z.string().optional(),
      }, async (args) => wrap(async () => text(await parseAndStoreJd(args)))()),

      tool('job_import', '把岗位加入岗位池（url 或 jd_raw），有 JD 文本时顺带解析。只有链接、没有 JD 文本时不要用它（只会存一个空链接）：先 browser_open 打开链接，再 browser_capture_job 收录。', {
        url: z.string().optional(), jd_raw: z.string().optional(), title: z.string().optional(), company_name: z.string().optional(),
        source_platform: z.enum(['boss', 'liepin', 'zhilian', '51job', 'campus', 'ats', 'manual']).optional(),
      }, async (args) => wrap(async () => {
        if (!args.url && !args.jd_raw) return err('url 或 jd_raw 至少提供一个');
        if (args.jd_raw) return text(await parseAndStoreJd(args));
        const job = repos().upsertJob({ source_platform: args.source_platform ?? 'manual', title: args.title ?? '未命名岗位', url: args.url ?? null, company_name: args.company_name ?? null });
        changed('job');
        return text({ job, note: '只记录了链接，没有 JD 文本，不能解析与评分。要收录完整岗位：browser_open 打开这个链接，再 browser_capture_job。' });
      })()),

      tool('job_evaluate', '岗位硬约束预筛 + 五维评分 + 投递建议（投不投由用户决定），预筛写入 job.prefilter_json.evaluate（保留来源数据），完整评估写入 score_json。', { job_id: z.string() }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const jd = jdOf(job);
        if (!jd) return err('该岗位还没有解析 JD，请先调用 jd_parse');
        const company = store().findCompany(job.company_name ?? '');
        const out = await askSkill<Record<string, unknown>>('job-evaluate', `JdParsed：\n${JSON.stringify(jd)}\n\n求职偏好：\n${JSON.stringify(prefs())}\n\n经历库已确认主张：\n${experienceDigest()}\n\n公司调研结论：${company?.traffic_light ?? '无'}`, { temperature: 0.2 });
        const prefilter = out.prefilter ?? out.hard_constraints ?? null;
        repos().db.update('job', job.id, { prefilter_json: mergeEvaluatePrefilter(job.prefilter_json, prefilter), score_json: JSON.stringify(out), updated_at: new Date().toISOString() });
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

      tool('resume_master_create', '创建主简历（母版）：默认从经历库已确认主张起草一份完整简历。基本信息和教育背景缺省从私密库取（姓名、联系方式、学校、专业、学历、毕业时间），不编造，也不要在对话里向用户要：私密库缺的核心项会自动出一张补齐卡。用户拖进过简历时走 resume_import 的卡片，点一下就生成，不必再调它。经历库为空时也能先建空壳。', {
        name: z.string().optional().describe('主简历名称，如"通用版"、"数据分析方向"；缺省按方向或"主简历"'),
        direction: z.string().optional().describe('求职方向'),
        basics: basicsSchema.optional().describe('用户明确给出的基本信息'),
        education: z.array(educationSchema).optional().describe('用户明确说过的教育背景；缺省用私密库里的学校 / 专业 / 学历 / 毕业时间'),
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
        const education = args.education?.length ? args.education : vaultEducation(filled);
        const base = { version: 1, basics, education };
        let draft: Record<string, unknown> | undefined;
        let missing: unknown = [];
        let usedClaimIds: unknown = [];
        let draftNotes = '';
        if ((args.draft ?? true) && claims.length > 0) {
          progress('resume_master_create', '正在从经历库起草主简历');
          const out = await askSkill<{ resume?: Record<string, unknown>; missing?: unknown; used_claim_ids?: unknown; notes?: string }>('resume-draft', `用户基本信息：\n${JSON.stringify(basics)}\n\n教育背景：\n${JSON.stringify(education)}\n\n求职方向：${args.direction ?? '未指定'}\n用户额外要求：${args.notes ?? '无'}\n\n经历库（只用 user_confirmed / verified 主张）：\n${experienceDigest()}`, { temperature: 0.2 });
          if (out.resume && typeof out.resume === 'object') {
            // 基本信息与教育以用户亲口给的为准，模型不得覆盖；私密库占位符优先级最高。
            draft = { ...out.resume, version: 1, basics: { ...(out.resume.basics as Record<string, unknown> | undefined ?? {}), ...basics }, ...(education.length ? { education } : {}) };
          }
          missing = out.missing ?? [];
          usedClaimIds = out.used_claim_ids ?? [];
          draftNotes = out.notes ?? '';
        }
        const schema = await normalizeResume(draft ?? base);
        const master = s.createResumeMaster({ name, direction: args.direction ?? null, schema_json: schema });
        changed('resume_master');
        focus({ surface: 'resume_editor', id: master.id });
        const stillMissing = vaultMissingCard();
        const missingNote = stillMissing.length ? '私密库还缺几项基本信息，对话里已出补齐卡，不要在对话里问。' : '';
        const note = draft
          ? `主简历已起草并在旁边打开。${missingNote}一句话告诉用户好了、可以直接在旁边改；不要逐区复述，不要请他在对话里确认。下一步是按岗位定制。`
          : claims.length === 0
            ? `经历库里还没有已确认的主张（${pendingCount > 0 ? `有 ${pendingCount} 条待确认，确认卡已在对话里` : '经历库为空'}），已先创建只含基本信息的主简历。${missingNote}有简历文件就请他拖进来（resume_import）；没有就从最近做过的一件事开始访谈。`
            : `已按 draft=false 创建只含基本信息的主简历。${missingNote}`;
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
        // 共用简历改了：没点开始的换成新版，其余如实列为改不了，对话里出一张更正卡（规范 §5.7）
        const { refreshQueuedPackets } = await import('../career/correction');
        const fix = await refreshQueuedPackets(packetDeps(), row.id);
        if (fix) {
          changed('action_queue', 'application_packet');
          card(`fix:${row.id}:${Date.now()}`, 'fix', '改了共用的简历', { swapped: fix.swapped_marks, locked: fix.locked_marks });
        }
        return text({ id: row.id, kind: found.kind, applied_ops: args.resume ? null : (args.patch?.length ?? 0), resume: schema,
          ...(fix ? { correction: { switched_to_new: fix.swapped.length, already_started_or_sent: fix.locked.length, note: '对话里已出更正卡，回复不必复述这两组数字' } } : {}) });
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

      tool('web_search', 'Web 搜索（博查 / Tavily / Serper）：查公司、行情、面经、笔试时间。要读结果里的某一页先 web_fetch，拿不到再 browser_open。', {
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
      tool('apply_prepare', '开始一份网申：为岗位创建投递记录，把要投的简历冻结成材料包（简历快照 + PDF + JD 原文），然后直接在托管浏览器上开始填写（填写本身不会提交，不需要用户事先批准）。填到提交按钮前停下：必填全部填好并核对过，就在对话里给用户一张提交卡片，用户批准后产品替用户点提交；还差项就给一张"还差 N 项要你补"的卡片，用户补好后调用 apply_continue 继续检查。遇登录 / 验证码 / 测评会暂停交给用户，用户交回后调用 apply_continue。不传 resume_id 时：用这个岗位的定制简历，没有就用唯一一份主简历；有多份主简历时会报错，请先让用户选。', {
        job_id: z.string(), resume_id: z.string().optional().describe('要投的简历 id（主简历或定制简历）'),
      }, async (args) => wrap(async () => {
        const job = requireJob(args.job_id);
        const r = repos();
        const picked = pickResumeForJob(store(), job.id, args.resume_id);
        if (args.resume_id && !picked) return err(`简历不存在：${args.resume_id}`);
        if (!picked && store().listResumeMasters().length > 1) return err(`有多份主简历，请先调用 resume_list 让用户选择这次投哪一份，再带上 resume_id：${store().listResumeMasters().map(m => `${m.id}（${m.name}）`).join('、')}`);
        const application = r.createApplication(job.id, picked?.kind === 'tailored' ? picked.id : null);
        progress('apply_prepare', '正在打包这次投递的简历');
        const { packet, warning } = await freezePacket(packetDeps(), { applicationId: application.id, jobId: job.id, resumeId: picked?.id ?? null });
        // 填表不需要事前批准：入队即批准（approved_by=system）并在同一个事务里认领成 executing，
        // 后台批量运行器只拾取 approved 的 fill_form，看不到这一份，不会两边各跑一次。
        const claimed = r.db.transaction(() => {
          const queued = r.enqueueAction('fill_form', { job_id: job.id, resume_id: picked?.id ?? null, packet_id: packet.id, application_id: application.id, url: job.url }, application.id, true);
          return r.claimAction(queued.id);
        });
        changed('application', 'action_queue');
        if (!claimed.ok) return err('这份网申没能开始填写，请稍后重试');
        try { r.jumpTo(application.id, 'approved', '开始填写网申（填写不会提交）'); } catch { /* 阶段已在更后面 */ }
        progress('fill_form', `开始填写「${jobLabel(job)}」的网申（${picked ? `用简历${resumeLabel(picked.id)}` : '没有简历附件'}）`);
        const res = await runDrive(claimed.action, 'start', { claimed: true });
        if (res.isError) return res;
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(res.content[0].text) as Record<string, unknown>; } catch { /* ignore */ }
        return text({ application_id: application.id, action_id: claimed.action.id, packet: { id: packet.id, resume_id: packet.resume_id, resume_kind: packet.resume_kind, resume_pick_reason: picked?.reason ?? null, has_pdf: !!packet.resume_pdf_path }, ...(warning ? { warning } : {}), ...body });
      })()),

      tool('jobs_board', '岗位汇总表 = 「岗位库」页那张表（校招 / 实习网申汇总 + 我的进度 + 可解释匹配）。筛选维度与页面一致：批次 batch / 行业 industry / 类型 type（校招、实习、社招、央国企、外企…）/ 地点 location / 进度 stage 均可多选，q 搜公司或岗位名；页面默认只看没截止的（open_only=true）。用户在岗位库页问"这些 / 当前筛选"时，把 refs.filters 换成这些参数（tag→type、city→location、progress→stage，其余同名），refs.job_ids 拆成数组传 job_ids。返回 total（符合条件的总数）+ 前 limit 条（按匹配分排序）；每条带批次 / 行业 / 类型标签和"哪条要求对应用户哪段经历"。推荐时只推荐 fits=true 的（不违反用户明确条件）。', {
        q: z.string().optional().describe('搜公司 / 岗位名'),
        batch: z.array(z.string()).optional().describe('批次，如 ["正式批","提前批"]'), industry: z.array(z.string()).optional().describe('行业，如 ["互联网"]'),
        type: z.array(z.string()).optional().describe('类型标签：校招 / 实习 / 社招（也可写 campus / intern / social）或企业性质，如 央国企、外企'),
        location: z.array(z.string()).optional().describe('城市，如 ["北京","上海"]'), stage: z.array(z.enum(['none', 'active', 'done'])).optional().describe('进度：none 未投递 / active 进行中 / done 已投出'),
        employment_type: z.enum(['campus', 'intern', 'social']).optional(), city: z.string().optional().describe('地点包含该词（模糊）'), cohort: z.string().optional().describe('如 2027届'),
        open_only: z.boolean().optional().describe('只看没截止的'), fits_only: z.boolean().optional().describe('只看符合用户条件的'), progress: z.enum(['none', 'active', 'done']).optional(),
        job_ids: z.array(z.string()).optional().describe('只看这些岗位（如页面上勾选的 refs.job_ids）'),
        sort: z.enum(['match', 'deadline', 'updated']).optional(), limit: z.number().int().min(1).max(200).optional().describe('返回条数，缺省 30，最多 200'),
      }, async (args) => wrap(async () => {
        const { jobBoard, getJobPrefs } = await import('../career/job-board');
        const { q, batch, industry, type, location, stage, job_ids, limit, ...base } = args;
        const ids = job_ids?.length ? new Set(job_ids) : null;
        const matched = filterBoardFacets(jobBoard(repos(), { ...base, limit: Number.MAX_SAFE_INTEGER }), { q, batch, industry, type, location, stage })
          .filter(row => !ids || ids.has(row.job.id));
        const rows = matched.slice(0, limit ?? 30);
        // 条数多时不展开逐条证据，避免结果被截断；要细看某几条再按 job_ids 查
        const detailed = rows.length <= 50;
        const applied = Object.fromEntries(Object.entries(args).filter(([k, v]) => k !== 'limit' && v !== undefined && !(Array.isArray(v) && v.length === 0)));
        return text({ prefs: getJobPrefs(repos()), total: matched.length, returned: rows.length, filters: applied, rows: rows.map(({ job, match, application, meta, target }) => ({
          job_id: job.id, target, job_key: job.job_key, company: job.company_name, title: job.title, type: job.employment_type, cohort: job.cohort, batch: meta.batch, industry: meta.industry, type_tags: boardTypeTags({ job, meta }),
          location: job.location, deadline: job.deadline, url: job.url, stage: boardStageOf({ application }), progress: application?.stage ?? null, score: match?.score ?? null, fits: match?.hard_ok ?? null, summary: match?.summary ?? '尚未计算匹配',
          ...(detailed ? {
            hard: match?.hard.filter(h => h.ok !== true).map(h => `${h.label}：${h.detail}`), covered: match?.requirements.filter(r => r.status === 'covered').map(r => `${r.requirement} ← ${r.evidence?.label ?? ''}「${r.evidence?.text.slice(0, 40) ?? ''}」`),
            missing: match?.requirements.filter(r => r.status === 'missing').map(r => r.requirement),
          } : {}),
        })), note: rows.length
          ? `${matched.length > rows.length ? `共 ${matched.length} 条，只返回前 ${rows.length} 条；` : ''}${detailed ? '' : '条数较多，未展开逐条匹配证据（要看细节用 job_ids 查）；'}匹配基于用户已确认的经历与简历文字；missing 里的要求不能替用户编造，只能建议去补证据或在面试准备里说明。`
          : '没有符合条件的岗位：可先 jobs_sync 同步校招数据，或放宽条件。' });
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

      tool('jobs_apply', '投这几个岗位（用户说「这些都投了」「投这 20 个」时用）：一次就开始——逐个冻结材料包、交给后台批量运行器填到提交前停下；标星的填好后先给他看，其余检查全过的合成「一键投出」。已在投、已投过、没有网申链接的跳过并给原因。没有定制版又有好几份主简历时，默认用最近改过的那份（结果里 resume 写明用了哪份）。不用你逐份 apply_run；回复一两句：开始了几家、跳过几家，要他做的事会出现在输入框上沿的「等你」里。不要让他回话确认。', {
        job_ids: z.array(z.string()).min(1).max(50), resume_id: z.string().optional().describe('统一用这份简历（定制版仍优先）；不传则用最近改过的主简历'),
      }, async (args) => wrap(async () => {
        const { applyJobs, planJobs } = await import('../career/batch-apply');
        progress('jobs_apply', `正在为 ${args.job_ids.length} 个岗位准备材料、开始投`);
        const masters = planJobs(repos(), store(), args.job_ids).resumes;
        const resume = args.resume_id ?? masters[0]?.id ?? null;
        const res = await applyJobs({ ...packetDeps(), store: store() }, args.job_ids, resume);
        changed('application', 'action_queue');
        // 对话里留一张批次卡（海报墙，只看状态、没有按钮）：这批投到哪了一眼可见
        if (res.started.length) review(res.started, 'fill_form', `投 ${res.started.length} 家`);
        return text({ started: res.started.length, skipped: res.skipped, ...(resume ? { resume: masters.find(m => m.id === resume)?.name ?? resume } : {}) });
      })()),

      tool('apply_run', '在托管浏览器上执行一份已经排进队列的填表动作（不提交）。新开一份网申用 apply_prepare（准备好会直接开始填）；apply_run 用于队列里已批准的（如浏览器忙时放回队列的），也可以直接重试之前因暂时性问题失败的那份。遇验证码 / 登录 / 测评等自动暂停并交给用户接管，用户处理完后调用 apply_continue 从当前页继续。', { action_id: z.string() }, async (args) => wrap(async () => {
        const r = repos();
        let action = r.getAction(args.action_id);
        if (!action) return err(`动作不存在：${args.action_id}`);
        if (action.kind !== 'fill_form') return err('apply_run 只执行填表动作；提交由用户在提交卡批准后自动执行');
        if (action.status === 'failed' && r.retryFailedFill(action.id)) {
          action = r.getAction(args.action_id)!; // 瞬时失败复活：原批准仍有效，直接重跑
        }
        if (action.status !== 'approved') return err(`动作状态为 ${action.status}，只能执行已批准（approved）的动作${applyStatusHint(action.status)}`);
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

      tool('apply_continue', '从当前页面继续填表并重新检查（不重新打开链接，不提交）：用户在浏览器里处理完登录 / 验证码 / 测评并交还后，或在卡片里补齐了缺项后调用。', { action_id: z.string().describe('之前 apply_prepare / apply_run 返回的 action_id') }, async (args) => wrap(async () => {
        const action = repos().getAction(args.action_id);
        if (!action) return err(`动作不存在：${args.action_id}`);
        if (action.status !== 'needs_user' && action.status !== 'executing') return err(`动作状态为 ${action.status}，只有接管中（needs_user / executing）的填表动作可以继续${applyStatusHint(action.status)}`);
        return runDrive(action, 'continue');
      })()),

      tool('greeting_compose', '生成平台招呼语（≤120 字）并自评审，入 send_greeting 待审队列；永远不会直接发送：用户批准后动作变为 needs_user（招呼语定稿），由用户本人复制到平台发送，不要说成"已发送"。', {
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

      // ---------- 浏览第一层：直取（不开浏览器） ----------
      tool('web_fetch', '直接取网页文字，不开浏览器（快，不占浏览器）：文章、公告、公众号推文、帖子、百科、PDF 这类页面先用它。返回 verdict：ok 就用 text；needs_browser / login / blocked 按 note 改用 browser_open（单页应用、要登录、被反爬），不要当成失败告诉用户。', {
        url: z.string().describe('http(s) 网址'),
      }, async (args) => wrap(async () => {
        if (!/^https?:\/\//i.test(args.url)) return err('web_fetch 需要 http(s) 网址');
        const { fetchPage } = await import('../career/web-fetch');
        const page = await fetchPage(args.url);
        console.log(`[career] web_fetch verdict=${page.verdict} status=${page.status ?? '-'} chars=${page.text_total} host=${new URL(args.url).hostname}`);
        return text(page);
      })()),

      tool('learned_rules', 'AI 学到的「以后不用问我」：哪些网站的网申表已自学习免审（依据是哪几家）、auto 模式开没开、提交前在页面上改过并写回答案库的值（在哪家改的；私密类只给问题不给值）。用户问「为什么这家没让我审就提交了 / 你替我记了什么」时用；用户说「撤回某网站的免审」时传 revoke_host（如 app.mokahr.com）：计数清零，靠它批准、还没提交的退回待审，已投出的撤不回、如实告诉用户。', {
        revoke_host: z.string().optional().describe('要撤回免审的网站域名，取自 page_trusts[].host'),
      }, async (args) => wrap(async () => {
        const { listLearnedRules, revokePageTrust } = await import('../career/learned-rules');
        if (!args.revoke_host) return text(listLearnedRules(repos()));
        const out = revokePageTrust(repos(), { host: core.normalizeHost(args.revoke_host) });
        if (!out.revoked) return err(`${args.revoke_host} 上没有免审中的表；先不传参数看看有哪些`);
        changed('kv', 'action_queue');
        return text(out);
      })()),

      // ---------- 模型逐步浏览（Global career/browse.ts；和填表引擎、现场画面同一个托管 Chrome） ----------
      tool('browser_open', '在托管浏览器的浏览页打开网址（任何网页：招聘站、岗位列表、公司官网、要登录的平台……），返回页面观察（带编号的可操作元素 + 正文摘要）。只读一篇文章 / PDF 先用 web_fetch；单页应用、要登录、要在页面上操作的用它。', {
        url: z.string().describe('http(s) 网址'),
      }, async (args) => wrap(async () => {
        const out = await browseCall({ action: 'act', act: { action: 'navigate', url: args.url } });
        return text(formatBrowse(out));
      })()),

      tool('browser_observe', '看当前浏览页：返回观察编号、带编号的可操作元素（链接 / 按钮 / 输入框 …）、正文摘要、标签页和需要本人处理的提示。操作前先看；页面变了要重新看。', {
        full_text: z.boolean().optional().describe('正文摘要多给一些（默认 1500 字）'),
      }, async (args) => wrap(async () => {
        const out = await browseCall({ action: 'observe', textMax: args.full_text ? 6000 : 1500 });
        return text(formatBrowse(out));
      })()),

      tool('browser_act', '操作浏览页。click / type / select / check 必须带最近一次观察的 observation_id 和元素编号 ref；press / scroll / back / forward / navigate / switch_tab / close_tab / wait 不需要；click_at（x, y）/ drag（x, y → to_x, to_y）按视口坐标操作，只在 DOM 编不了号时用（画布、图片）。回执说明有没有效果；observed_effect=unknown 或 retryable=false 时不要重复同一个操作，先 browser_observe。提交 / 投递类按钮会被拒绝（走 browser_capture_job → apply_prepare）。输入个人信息用 {{vault:...}} 占位符。', {
        action: z.enum(['click', 'type', 'select', 'check', 'press', 'scroll', 'back', 'forward', 'navigate', 'switch_tab', 'close_tab', 'wait', 'click_at', 'drag']),
        observation_id: z.string().optional(), ref: z.number().int().optional(),
        text: z.string().optional().describe('type 的内容；个人信息写 {{vault:profile.phone}} 这类占位符'),
        submit: z.boolean().optional().describe('type 后按回车（搜索框）'),
        option: z.string().optional().describe('select 的选项文字'), key: z.string().optional().describe('press 的按键，如 Enter / PageDown'),
        direction: z.enum(['up', 'down']).optional(), url: z.string().optional(), tab: z.number().int().optional().describe('标签页序号'), ms: z.number().int().optional(),
        x: z.number().optional(), y: z.number().optional(), to_x: z.number().optional(), to_y: z.number().optional(),
      }, async (args) => wrap(async () => {
        const out = await browseCall({ action: 'act', act: args });
        return text(formatBrowse(out));
      })()),

      tool('browser_cdp', '对当前浏览页的调试器会话直接发 CDP 命令（白名单：Page / Input / DOM / Runtime / Emulation）。典型用法：跨域 iframe（验证码常在这里）执行 JS——Page.getFrameTree 找 frameId → Page.createIsolatedWorld 拿 contextId → Runtime.evaluate 带 contextId；量元素坐标用 Runtime.evaluate 返回 getBoundingClientRect。截图返回的 base64 会被截断，看图用 browser_solve_captcha。遇到坐标点不中、下拉打不开先 browser_sop。', {
        method: z.string().describe('CDP 方法名，如 Runtime.evaluate'),
        params: z.record(z.string(), z.unknown()).optional().describe('方法参数对象'),
      }, async (args) => wrap(async () => {
        const out = await browseCall({ action: 'cdp', method: args.method, ...(args.params ? { params: args.params } : {}) });
        return text(JSON.stringify(out.cdp ?? out));
      })()),

      tool('browser_sop', '读浏览器操作经验手册：坐标为什么点不中（调试器黄条会把页面推下约 20px）、自绘下拉框怎么开、滑块怎么拖、跨域 iframe 怎么执行 JS、视口外的勾选框怎么办、扩展截图超时怎么办。遇到操作不动 / 点了没反应先读它，不要连点。', {}, async () => wrap(async () => text(BROWSE_SOP))()),

      tool('browser_read', '分页读取浏览页的正文（岗位详情、公司介绍等），每次约 4000 字；next_offset 不为空时继续读。', {
        offset: z.number().int().min(0).optional(),
      }, async (args) => wrap(async () => {
        const out = await browseCall({ action: 'read', offset: args.offset ?? 0 });
        return text(out.read ?? out);
      })()),

      tool('browser_solve_captcha', '浏览页上出现验证码 / 人机验证时，先用它自己过（图形字、点选、滑块拼图 / 旋转），不要一看到验证码就去找用户。返回 solved 就接着做原来的事；needs_user（短信码、认不出的、试了两次没过）再用 browser_wait_user 请用户帮一下。同一页不要连着调用超过一次。', {}, async () => wrap(async () => {
        const out = await browseCall({ action: 'solve_captcha' });
        return text(formatSolveCaptcha(out));
      })()),

      tool('browser_wait_user', '请用户帮一下只有他能做的事（扫码登录、短信验证码、二次验证、browser_solve_captcha 过不了的验证码），他做完就接着办——这不是失败，不要因此放弃任务。会把浏览器现场切到这一页，然后等：登录框 / 验证码消失或他点了「交还」，就返回新观察，你接着做原来的事。调用前先用一句话告诉他要做什么（例如「打开右边的浏览器，用牛客 App 扫一下二维码」）。', {
        what: z.string().describe('给用户看的一句话：要他做什么'),
        waiting_for: z.enum(['login', 'captcha', 'other']).optional().describe('等什么消失：login = 登录框，captcha = 验证码 / 风控页，other = 等页面跳走'),
        timeout_s: z.number().int().min(5).max(600).optional().describe('最多等多少秒，缺省 180'),
      }, async (args) => wrap(async () => {
        const waitingFor = args.waiting_for ?? 'login';
        const blocking = waitingFor === 'login' ? ['login'] : waitingFor === 'captcha' ? ['captcha', 'risk'] : [];
        const out = await browseCall({ action: 'wait_user', what: args.what, blocking, timeoutMs: (args.timeout_s ?? 180) * 1000 });
        return text(formatWaitUser(out));
      })()),

      tool('browser_capture_job', '把当前浏览页（岗位详情页）收录成岗位：读取正文作为 JD 原文并解析，写入岗位池。之后可以 job_evaluate 评估，用户要投就 apply_prepare。', {
        title: z.string().optional(), company_name: z.string().optional(),
        source_platform: z.enum(['boss', 'liepin', 'zhilian', '51job', 'campus', 'ats', 'manual']).optional(),
      }, async (args) => wrap(async () => {
        let offset = 0; let jd = ''; let url = ''; let title = '';
        for (let i = 0; i < 4; i++) {
          const out = await browseCall({ action: 'read', offset, length: 6000 });
          const r = out.read as { text: string; next_offset: number | null; url: string; title: string };
          jd += r.text; url = r.url; title = r.title;
          if (r.next_offset == null) break;
          offset = r.next_offset;
        }
        if (jd.trim().length < 50) return err('这一页没有读到足够的正文，可能还没加载完或不是岗位详情页；先 browser_observe 看看');
        const { job, parsed } = await parseAndStoreJd({ url, jd_raw: jd.slice(0, 20_000), title: args.title ?? (title || undefined), company_name: args.company_name, source_platform: args.source_platform ?? 'manual' });
        changed('job');
        return text({ job: { id: job.id, title: job.title, company_name: job.company_name, url: job.url }, parsed_title: (parsed as { title?: string }).title ?? null, note: '已收录。接下来可以 job_evaluate；用户决定投递就 apply_prepare（会让用户批准）。' });
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
        const carried = carryoverFor(store(), repos(), job, args.round);
        const out = await askSkill<{ questions?: Array<{ type?: string; question?: string; probe_points?: string[]; difficulty?: string; jd_requirement?: string }>; coverage_note?: string }>('interview-questions', `${jobDigest(job)}\n岗位类别：${args.category ?? '未知'}\n企业性质：${args.company_type ?? '未知'}\n轮次：${args.round ?? '未知'}\n\n用户经历摘要：\n${experienceDigest()}\n\n${carryoverPrompt(carried)}`, { refs: args.category ? [args.category] : [], temperature: 0.5 });
        // 出的题进题库（来源 generated，绑定岗位），之后练习、真实面试遇到都能对上同一道题
        const r = repos();
        const questions = (out.questions ?? []).filter(q => q?.question).map(q => ({ ...q, question_id: r.upsertQuestion({ content: q.question!, kind: 'interview', category: q.type ?? null, probe_points: q.probe_points ?? [], jd_requirement: q.jd_requirement ?? null, company_name: job.company_name, title: job.title, job_id: job.id, source: 'generated', source_ref: `generated:${job.id}`, tags: q.difficulty ? [q.difficulty] : [] }).id }));
        if (questions.length) changed('question');
        return text({ ...out, questions, carried_from: carried.retros.map(r => ({ interview_id: r.interview_id, company: r.company, round: r.round })), note: '题目已存进题库（question_id）。用户练习作答后用 question_attempt 打分记录，便于比较进步。carried_from 是这次带上的往场复盘，告诉用户「按上次卡住的地方出了题」。' });
      })()),

      tool('interview_prep', '「帮我准备 X 的面试」的收尾：在对话里出一张面试准备卡（时间、上一轮 / 同类面试卡在哪、三个高风险深挖点、几道题、开始模拟按钮）。先用 interview_predict 和 interview_questions 补上预测和题（返回的 missing 会说缺哪样），再调它出卡；卡片已经把要点摆出来，回复里不要再逐条重复。', {
        application_id: z.string().optional(), company_name: z.string().optional(), interview_id: z.string().optional().describe('从通知中心 / 面试页点进来时带的那场面试'),
      }, async (args) => wrap(() => {
        let appId = args.application_id ?? (args.interview_id ? store().getInterview(args.interview_id)?.application_id ?? undefined : undefined);
        if (!appId && args.company_name) {
          const found = applicationForInterview(repos(), args.company_name);
          if (found.candidates.length) return err(`${args.company_name} 有 ${found.candidates.length} 份在投、都没有排着的面试，分不出要准备哪一份：${found.candidates.map(c => `${c.label}（${c.application_id}）`).join('、')}。用 dossier_list 看看最近的动静能不能定；定不了就把这几份列成选项一次问完`);
          appId = found.application_id;
        }
        if (!appId) return err('需要 application_id、interview_id 或公司名；可以先用 dossier_list 找');
        const prep = buildInterviewPrep(store(), repos(), appId);
        card(`interview-prep:${prep.interview_id ?? appId}`, 'interview_prep', `准备 ${prep.company ?? ''} ${prep.title}`.trim(), { ...prep });
        return text({ ...prep, note: prep.missing.length ? `还缺：${prep.missing.join('、')}；补上后再调一次 interview_prep 更新卡片。` : '准备卡已出现在对话里。' });
      })()),

      tool('interview_book', '记一场邮箱里没有的面试（HR 电话 / 短信 / 微信约的）：用户说「我约了周四下午百度二面」就用它。找到或建好这份申请、推进到面试、记面试和时间点；没说时间也先记（时间待定），同一场再记一次只改时间。邮件来的面试邀请走 inbox_capture。', {
        company_name: z.string(), title: z.string().optional(), round: z.string().optional().describe('如 一面 / 二面 / HR 面 / 终面'),
        when: z.string().optional().describe('ISO 时间，如 2026-11-05T14:00:00+08:00；用户没说就不传，先记上（时间待定），不要为了时间追问'), location: z.string().optional().describe('会议链接或地点'), note: z.string().optional(), application_id: z.string().optional(),
      }, async (args) => wrap(() => {
        const out = bookInterview(store(), repos(), args);
        changed('application', 'application_history', 'interview', 'deadline');
        focus({ surface: 'dossier', application_id: out.application_id });
        return text(out);
      })()),

      tool('job_target', '把岗位标成 / 取消目标岗位（重点打磨的那几个）。只在用户亲口说「这几个是我的目标 / 重点准备」时用，不要替用户判断哪些是目标；进过面试的申请自动算目标，不用标。', {
        job_id: z.string().optional(), application_id: z.string().optional(), target: z.boolean(),
      }, async (args) => wrap(() => {
        const jobId = args.job_id ?? (args.application_id ? repos().getApplication(args.application_id)?.job_id : undefined);
        if (!jobId) return err('需要 job_id 或 application_id');
        setTargetJob(repos(), jobId, args.target);
        changed('kv');
        return text({ job_id: jobId, target: args.target, note: args.target ? '已标成目标岗位。' : '已取消你的标记；进过面试的申请仍算目标。' });
      })()),

      tool('interview_probe', '模拟面试 / 简历深挖：漏斗追问。首轮不传 transcript 时给开场问题；传 transcript 时给追问或结束复盘。一场模拟记一条 mock_interview：接着练时带上首轮返回的 mock_interview_id。', {
        job_id: z.string().optional(), resume_id: z.string().optional(), company_type: z.enum(['大厂', '创业公司', '国企央企', '外企']).optional(), round: z.string().optional(),
        transcript: z.string().optional().describe('到目前为止的问答记录'), finish: z.boolean().optional().describe('结束并产出复盘'),
        mock_interview_id: z.string().optional().describe('接着练同一场时传上一轮返回的 mock_interview_id；不传就开新的一场'),
      }, async (args) => wrap(async () => {
        // 隔了一会儿「接着练」只给了 mock_interview_id：从上次存下的问答接着问，岗位和轮次也沿用
        const prior = args.mock_interview_id ? store().getMockInterview(args.mock_interview_id) : undefined;
        if (args.mock_interview_id && !prior) return err(`模拟面试不存在：${args.mock_interview_id}`);
        if (prior) args = { ...args, job_id: args.job_id ?? prior.job_id ?? undefined, round: args.round ?? prior.round ?? undefined, transcript: args.transcript ?? lastTranscript(prior) };
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const resume = interviewResume(store(), repos(), args);
        const carried = job ? carryoverPrompt(carryoverFor(store(), repos(), job, args.round)) : '';
        const out = await askSkill<Record<string, unknown>>('interview-probe', `${job ? jobDigest(job) : '岗位：未指定'}\n企业性质：${args.company_type ?? '未知'}\n轮次：${args.round ?? '未知'}\n\n简历 / 主张：\n${resume ? resume.row.schema_json : experienceDigest(false)}\n\n${carried}\n\n已进行的问答：\n${args.transcript ?? '（尚未开始，请给出开场问题）'}\n\n${args.finish ? '请结束并给出面试官视角复盘。' : '请给出下一步追问（JSON）。'}`, { refs: args.company_type ? [args.company_type] : [], temperature: 0.6 });
        const turns = args.transcript ? [{ transcript: args.transcript }] : undefined;
        const mock = args.mock_interview_id
          ? store().updateMockInterview(args.mock_interview_id, { turns, report: args.finish ? out : undefined })
          : store().createMockInterview({ job_id: args.job_id ?? null, resume_tailored_id: resume?.kind === 'tailored' ? resume.row.id : null, mode: 'probe', company_type: args.company_type ?? null, round: args.round ?? null, turns: turns ?? [], report: args.finish ? out : undefined });
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
          progress('resume_ats', '正在导出并做机筛自检');
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
        follow_up_questions: z.array(z.string()).max(5).optional().describe('下一轮要问的 3–5 个事实问题；带 experience_id 时记在这段经历上，传空数组表示这段聊完了'),
      }, async (args) => wrap(() => {
        const r = repos();
        const cur = r.kvGet<import('@career/core').InterviewState>(core.INTERVIEW_STATE_KEY) ?? { rounds: {} };
        if (args.round || args.status || args.experience_id !== undefined || args.follow_up_questions) {
          const merged = { ...cur, rounds: { ...cur.rounds, ...(args.round && args.status ? { [args.round]: args.status } : {}) }, ...(args.round ? { current_round: args.round } : {}), ...(args.experience_id !== undefined ? { current_experience_id: args.experience_id } : {}), ...(args.follow_up_questions ? { follow_up_questions: args.follow_up_questions } : {}), updated_at: new Date().toISOString() };
          const next = args.experience_id && args.follow_up_questions ? core.withOpenExperience(merged, args.experience_id, args.follow_up_questions) : merged;
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
        const out = await askSkill<{ new_claims?: Array<{ text?: string; attribution?: 'self' | 'team' | 'unknown' }> }>('project-story', `讲述文本：\n${args.text}\n\n对应主张：\n${claims.map(c => `- [${c.status}/${c.attribution}] ${c.text}`).join('\n') || '（无）'}\n\n${job ? jobDigest(job) : ''}\n目标时长：${args.target_seconds ?? 105} 秒`, { temperature: 0.3 });
        const experience = args.experience_id ? repos().getExperience(args.experience_id) : undefined;
        const added = experience ? (out.new_claims ?? []).filter(c => c.text?.trim()).map(c => repos().addClaim({ experience_id: experience.id, text: c.text!, attribution: c.attribution, created_from: 'interview' })) : [];
        if (added.length) { changed('claim'); claimsCard(experience!, added); }
        return text({ ...out, saved_claim_ids: added.map(c => c.id) });
      })()),

      tool('interview_retro', '真实面试复盘：逐题诊断、信号判读、受控标签，归档到面试库（证据与推断分开，不预测结果）。用户说了几句或传了录音转写，就直接调它：材料少也复盘，记不清的标材料不足、列进「还要补」，不要追问原话、不要让他再讲一遍；公司、轮次从邀请那场补（传 interview_id 或公司名即可）。全文会留在面试页，回复只说一两句：最要紧的一处和下一场怎么用上，不要逐题复述。', {
        transcript: z.string(), interview_id: z.string().optional(), company_name: z.string().optional(), title: z.string().optional(),
        round: z.enum(['hr', 'first', 'second', 'final', 'group', 'other']).optional(), company_type: z.string().optional(), date: z.string().optional(),
        result: z.enum(['none', 'rejected', 'advanced', 'no_feedback_inferred']).optional(), result_source: z.enum(['none', 'official', 'inferred']).optional(),
      }, async (args) => wrap(async () => {
        const out = await runInterviewRetro(store(), repos(), askSkill, card, args);
        changed(...out.tables);
        return text({ interview_id: out.interview_id, retro: out.retro, questions_saved: out.questions_saved, followups: out.followups.map(f => ({ experience: f.experience_title, new_claims: f.claims.length, gaps: f.gaps })), note: '复盘全文已在面试页；回复一两句即可。' });
      })()),

      tool('interview_predict', '从简历 / 主张预测面试深挖点：靶子类型、预期追问链、露馅风险，写入 probe_prediction。', {
        resume_id: z.string().optional(), job_id: z.string().optional(), company_type: z.string().optional(), round: z.string().optional(),
      }, async (args) => wrap(async () => {
        const job = args.job_id ? requireJob(args.job_id) : undefined;
        const resume = interviewResume(store(), repos(), args);
        const carried = job ? carryoverPrompt(carryoverFor(store(), repos(), job, args.round)) : '';
        const out = await askSkill<{ predictions?: Array<{ statement: string; target_type?: string; expected_chain?: unknown; risk?: string; claim_id?: string }> }>('probe-predict', `简历 / 主张：\n${resume ? resume.row.schema_json : experienceDigest(false)}\n\n${job ? jobDigest(job) : '岗位：未指定'}\n企业性质：${args.company_type ?? '未知'}，轮次：${args.round ?? '未知'}\n\n${carried ? `${carried}\n\n` : ''}输出 JSON：{"predictions":[{"statement":"","target_type":"data|project|industry|method","expected_chain":[],"risk":"high|mid|low","claim_id":""}]}`, { temperature: 0.3 });
        const rows = store().addProbePredictions((out.predictions ?? []).filter(p => p?.statement).map(p => ({ statement: p.statement, target_type: p.target_type ?? 'project', expected_chain: p.expected_chain, risk: p.risk, claim_id: p.claim_id || null, resume_tailored_id: resume?.kind === 'tailored' ? resume.row.id : null })));
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

      ...createResumeChainTools({
        tool, z, repos, vault, store, profileFields: core.PROFILE_FIELDS, mask: core.maskValue, wrap, text, err, changed, card, progress,
        askSkill: (skill, user, opts) => askSkill(skill, user, opts),
        readDocument: abs => (deps.readDocument ?? readDocumentDefault)(abs, sessionCtx.workspace),
        workspacePath, fileExists: existsSync, resolveMaster, requireJob, jdOf,
        parseJd: async jobId => (await parseAndStoreJd({ job_id: jobId })).parsed, confirmedClaims,
      }),
      ...createOfferTools({ tool, z, repos, store, wrap, text, err, changed, askSkill: (skill, user, opts) => askSkill(skill, user, opts), userContext: () => `用户经历与偏好：\n${experienceDigest()}\n${JSON.stringify(prefs())}` }),
    ],
  });
}
