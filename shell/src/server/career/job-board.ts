/**
 * 岗位汇总表（R01 校招与实习网申汇总 / R02 依据简历找匹配岗位 / R06 框选一批确认就开始投，见 batch-apply.ts）。
 *
 *  - 求职条件 kv `profile.job_prefs`（届别 / 学历 / 城市 / 类型 / 方向词），推荐不得违反。
 *  - 匹配证据：已确认的经历主张 + 主简历（及定制版）里的条目文字；`matchJob` 逐条要求对证据，结果存 job.match_json / match_score。
 *  - 汇总表：岗位 + 我的进度（投递阶段）+ 匹配，按筛选条件与排序给出。
 *  - prepareJobs：给一批岗位逐个建投递、排 fill_form（payload 带 resume_plan；只由 batch-apply 调，排完立刻批准开始；没有「待投清单」这一步）。
 *    不定制、不导 PDF：那两步在后台运行器开跑前做（packet-prepare.ts），「投这 N 家」当场就回。
 *
 * 汇总表维度（批次 / 行业 / 类型标签）的存放约定——所有导入路径与读取方都按这个来：
 *  - 权威位置是 job.board_json（迁移 v7），形如 `{"batch":"正式批"|null,"industry":"互联网"|null,"type_tags":["央国企"]}`，
 *    归一 / 合并规则在 @career/core jobs.ts（normalizeBoardMeta / serializeBoardMeta / mergeBoardMeta）。
 *  - 写入方：校招静态数据（bridges/campusRadar.ts mapCampusJob）、服务端同步（server-api.ts upsertListings，
 *    JobListing.batch / industry / type_tags）、手动导入（routes/career.ts /jobs/import，可带 batch / industry / type_tags，
 *    并合并 JD 解析得到的维度）、JD 解析入库与邮件建岗（intake.ts）。拿不到就不写，不猜。
 *  - 岗位评估（job_evaluate）只写 prefilter_json.evaluate / score_json，永远不碰 board_json。
 *  - 兼容：老数据没有 board_json 时回退读 prefilter_json.campus（campus-radar 早期写法；评估合并时保留该键）。
 */
import { JOB_PREFS_KEY, matchJob, normalizeBoardMeta, parseBoardJson, type Application, type Job, type JobBoardMeta, type JobMatch, type JobPrefs, type MatchEvidence, type Repos } from '@career/core';

import { isSubmittedStage } from '../../shared/careerStages';
import { missingVaultFields, pickResumeForJob, resumePlanForJob, tailoredChangeCount, type PacketDeps, type PacketResumePlan } from './packets';
import type { CareerStore } from './store';
import { markedTargetJobs, targetSourceOf, type TargetSource } from './targets';

export function getJobPrefs(repos: Repos): JobPrefs { return repos.kvGet<JobPrefs>(JOB_PREFS_KEY) ?? {}; }
export function setJobPrefs(repos: Repos, prefs: JobPrefs): JobPrefs {
  const clean: JobPrefs = {
    cohort: prefs.cohort?.trim() || null, degree: prefs.degree?.trim() || null,
    cities: (prefs.cities ?? []).map(c => c.trim()).filter(Boolean),
    employment_types: (prefs.employment_types ?? []).filter(t => ['campus', 'intern', 'social'].includes(t)),
    keywords: (prefs.keywords ?? []).map(k => k.trim()).filter(Boolean),
  };
  repos.kvSet(JOB_PREFS_KEY, clean);
  return clean;
}

/** 匹配证据：只用用户确认过 / 有强证据的主张（不编造）+ 简历条目文字。 */
export function matchEvidence(repos: Repos, store: CareerStore): MatchEvidence[] {
  const out: MatchEvidence[] = [];
  for (const e of repos.experienceTree()) {
    for (const c of e.claims) if (c.status !== 'pending') out.push({ id: c.id, kind: 'claim', text: c.text, label: [e.org, e.title].filter(Boolean).join(' · ') });
  }
  for (const m of store.listResumeMasters()) {
    for (const [i, text] of flattenResume(m.schema_json).entries()) out.push({ id: `${m.id}#${i}`, kind: 'resume', text, label: `简历「${m.name}」` });
  }
  return out;
}

function flattenResume(raw: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string') { if (v.length >= 4 && !/^\{\{vault:/.test(v) && !/(phone|email|name|url|id)$/i.test(key)) out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'basics') walk(x, k);
  };
  try { walk(JSON.parse(raw)); } catch { /* ignore */ }
  return out;
}

/** 重新计算（全部或指定）岗位的匹配。 */
export function computeMatches(repos: Repos, store: CareerStore, jobIds?: string[], today?: string): number {
  const prefs = getJobPrefs(repos);
  const evidence = matchEvidence(repos, store);
  const jobs = jobIds?.length ? jobIds.map(id => repos.getJob(id)).filter((j): j is Job => !!j) : repos.listJobs();
  repos.db.transaction(() => {
    for (const job of jobs) {
      const m = matchJob({ job, prefs, evidence, today });
      repos.db.update('job', job.id, { match_json: JSON.stringify(m), match_score: m.score });
    }
  });
  return jobs.length;
}

export interface BoardFilter {
  q?: string; employment_type?: string; city?: string; cohort?: string;
  /** 只看没截止的。 */
  open_only?: boolean;
  /** 只看符合我条件的（硬条件全过）。 */
  fits_only?: boolean;
  /** 投递进度：none 未投 / active 进行中 / done 已投出 */
  progress?: 'none' | 'active' | 'done';
  sort?: 'match' | 'deadline' | 'updated';
  limit?: number;
}
export interface BoardRow {
  job: Job; match: JobMatch | null;
  application: { id: string; stage: string; next_action: string | null; updated_at: string } | null;
  /** 多维表格用的维度（批次 / 行业 / 类型标签），从来源数据里能拿到的才有，拿不到为空，不猜。 */
  meta: BoardMeta;
  /** 目标岗位：进过面试（interview）或用户亲手标的（user）；其余为 null，系统不替用户认定。 */
  target: TargetSource | null;
}
export type BoardMeta = JobBoardMeta;

/** 维度读取：board_json 优先；没有时回退 prefilter_json.campus（老数据）。prefilter_json 里其他键（evaluate 等）一概不看。 */
export function boardMeta(job: Pick<Job, 'prefilter_json'> & { board_json?: string | null }): BoardMeta {
  const board = parseBoardJson(job.board_json);
  if (board) return board;
  let campus: Record<string, unknown> | null = null;
  try {
    const raw = job.prefilter_json ? JSON.parse(job.prefilter_json) as unknown : null;
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).campus : null;
    if (c && typeof c === 'object' && !Array.isArray(c)) campus = c as Record<string, unknown>;
  } catch { /* 坏 JSON 当没有 */ }
  return normalizeBoardMeta(campus ? { batch: campus.batch, industry: campus.industry } : null);
}

/**
 * 内测期岗位库只收、只显示有网申链接的岗位（立场：岗位库里能找到的岗位就一定能投）。
 * 这是接上自爬云端岗位库之前的临时过滤：内置校招汇总 443 条里只有约 121 条带 apply_url，
 * 没链接的条目既投不了也不该出现在库里。云端库接通后（每条都有可投入口）可把它关掉。
 */
export const BETA_LIBRARY_REQUIRES_APPLY_LINK = true;

/** 内置校招数据进库的统一筛选：首次自动导入与手动「同步校招汇总」共用——不收已过期的、内测期不收没链接的。 */
export function campusLibraryFilter(): { excludeExpired: true; requireApplyUrl: boolean } {
  return { excludeExpired: true, requireApplyUrl: BETA_LIBRARY_REQUIRES_APPLY_LINK };
}

/** 汇总表里这一行能不能出现：内测期没链接的岗位不显示；已经建了投递的照常显示（那是用户自己的进度）。 */
function shownInLibrary(job: Job, application: BoardRow['application']): boolean {
  return !BETA_LIBRARY_REQUIRES_APPLY_LINK || !!job.url?.trim() || !!application;
}

/** 首次自动导入只用到 bridges 里校招数据的三个函数（测试可注入）。 */
export type CampusSeedBridges = Pick<typeof import('@career/bridges'), 'loadCampusJobs' | 'filterCampusJobs' | 'importCampusJobs'>;
export const CAMPUS_SEEDED_KEY = 'jobs:campus:auto_seeded_at';

/**
 * 岗位表为空且从没自动导入过时，导入一次内置校招数据并算匹配（首次打开汇总表不是一张空表）。
 * 幂等：成功后记 kv，之后即使用户清空了岗位也不再自动导入；读不到数据（发布包缺文件等）只返回 null，不打断列表读取。
 */
export function seedCampusJobsIfEmpty(repos: Repos, store: CareerStore, bridges: CampusSeedBridges): { stored: number } | null {
  if (repos.kvGet<string>(CAMPUS_SEEDED_KEY)) return null;
  if (repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')?.n) return null;
  let stored: number;
  try {
    const items = bridges.filterCampusJobs(bridges.loadCampusJobs(), campusLibraryFilter());
    stored = bridges.importCampusJobs(repos, items).length;
  } catch (error) {
    console.warn('[career] 首次自动导入校招数据失败:', error instanceof Error ? error.message : error);
    return null;
  }
  repos.kvSet(CAMPUS_SEEDED_KEY, new Date().toISOString());
  if (stored) computeMatches(repos, store);
  return { stored };
}

const DONE = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired', 'skip']);

export function jobBoard(repos: Repos, f: BoardFilter = {}, today = new Date().toISOString().slice(0, 10)): BoardRow[] {
  const apps = new Map<string, BoardRow['application']>();
  for (const a of repos.listApplications()) if (!apps.has(a.job_id)) apps.set(a.job_id, { id: a.id, stage: a.stage, next_action: a.next_action, updated_at: a.updated_at });
  const q = f.q?.trim().toLowerCase();
  const marked = markedTargetJobs(repos);
  const reached = new Map<string, string[]>();
  for (const h of repos.stageHistory()) reached.set(h.application_id, [...(reached.get(h.application_id) ?? []), h.to_stage]);
  const targetOf = (job: Job, app: BoardRow['application']) => targetSourceOf({ job_id: job.id, stage: app?.stage ?? '' }, app ? reached.get(app.id) ?? [] : [], marked);
  let rows: BoardRow[] = repos.listJobs().filter(j => j.source_status !== 'merged').map(job => ({ job, match: parseMatch(job.match_json), application: apps.get(job.id) ?? null, meta: boardMeta(job), target: targetOf(job, apps.get(job.id) ?? null) }));
  rows = rows.filter(({ job, match, application }) => {
    if (!shownInLibrary(job, application)) return false;
    if (q && !`${job.company_name ?? ''} ${job.title} ${job.location ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.employment_type && job.employment_type !== f.employment_type) return false;
    if (f.city && !(job.location ?? '').includes(f.city)) return false;
    if (f.cohort && job.cohort && job.cohort !== f.cohort) return false;
    if (f.open_only && ((job.deadline && job.deadline.slice(0, 10) < today) || job.source_status === 'closed')) return false;
    if (f.fits_only && match && !match.hard_ok) return false;
    if (f.progress === 'none' && application) return false;
    if (f.progress === 'active' && (!application || DONE.has(application.stage))) return false;
    if (f.progress === 'done' && (!application || !DONE.has(application.stage))) return false;
    return true;
  });
  const sort = f.sort ?? 'match';
  rows.sort((a, b) => sort === 'deadline' ? (a.job.deadline ?? '9999').localeCompare(b.job.deadline ?? '9999')
    : sort === 'updated' ? b.job.updated_at.localeCompare(a.job.updated_at)
      : (b.match?.score ?? -1) - (a.match?.score ?? -1) || (a.job.deadline ?? '9999').localeCompare(b.job.deadline ?? '9999'));
  return rows.slice(0, f.limit ?? 1000);
}

function parseMatch(raw: string | null | undefined): JobMatch | null { try { return raw ? JSON.parse(raw) as JobMatch : null; } catch { return null; } }

/** PacketDeps 里的 exportPdf / exportsDir 这里不用（开跑前才导），留着是为了调用方（applyJobs / prepareAhead）同一份 deps。 */
export type PrepareDeps = PacketDeps & {
  store: CareerStore;
  /** 私密库里没有的占位符（Vault.unresolved）；缺省在简历里真有占位符时才去开私密库。 */
  vaultUnresolved?: (text: string) => string[];
};
export interface PrepareResult { job_id: string; ok: boolean; action_id?: string; reason?: string; resume_plan?: PacketResumePlan }
export type { PacketResumePlan } from './packets';

type Candidate = { job: Job; existing: Application | undefined; resumeId: string; plan: PacketResumePlan };

/** 一个岗位能不能开始投：不能就给原因；能就给出要用的简历（定制版优先，没有就主简历，并标出要不要先定制）。 */
function candidateOf(deps: PrepareDeps, jobId: string, resumeId: string | null | undefined, fallbackResumeId: string | null | undefined): Candidate | string {
  const job = deps.repos.getJob(jobId);
  if (!job) return '岗位不存在';
  const apps = deps.repos.listApplications().filter(a => a.job_id === jobId);
  // 已经投出去的岗位不再投第二次（框选时常会连带勾上已投的那几行）
  if (apps.some(a => isSubmittedStage(a.stage))) return '已经投过';
  const existing = apps.find(a => !DONE.has(a.stage));
  if (existing && deps.repos.listActions().some(a => a.application_id === existing.id && ['pending_review', 'approved', 'executing', 'needs_user'].includes(a.status))) return '已在投';
  if (!job.url) return '没有网申链接';
  if (resumeId) {
    const picked = pickResumeForJob(deps.store, jobId, resumeId);
    return picked ? { job, existing, resumeId: picked.id, plan: { kind: picked.kind, changes: picked.kind === 'tailored' ? tailoredChangeCount(deps.repos, picked.id) : null, reason: 'explicit' } } : '你指定的简历不存在';
  }
  // 定制版优先；没有定制版又有好几份主简历时，用确认时选好的那份（fallbackResumeId），不再逐个问
  const plan = resumePlanForJob(deps.store, deps.repos, jobId, fallbackResumeId);
  if (!plan.resume_id) return '有多份主简历，请先选这次投哪一份';
  return { job, existing, resumeId: plan.resume_id, plan: { kind: plan.kind, changes: plan.changes } };
}

/** 简历里还有私密库解不开的占位符（缺的资料项）：导出来会把 {{vault:…}} 印在简历上，这家先不开始。 */
async function missingFieldsOf(deps: PrepareDeps, resumeId: string): Promise<string[]> {
  const schema = deps.store.getResume(resumeId)?.row.schema_json ?? '';
  if (!schema.includes('{{')) return [];
  let unresolved = deps.vaultUnresolved;
  if (!unresolved) {
    const vault = await (await import('./vault')).getVault();
    unresolved = text => vault.unresolved(text);
  }
  return missingVaultFields(schema, unresolved);
}

/** 建投递并排 fill_form（payload 带 resume_plan，开跑前由运行器按它定制、冻结）；缺资料的不开始。 */
async function enqueueCandidate(deps: PrepareDeps, c: Candidate): Promise<PrepareResult> {
  const missing = await missingFieldsOf(deps, c.resumeId);
  if (missing.length) {
    console.warn(`[career] prepare FAILED job=${c.job.id} reason=vault_missing fields=${missing.join(',')}`);
    return { job_id: c.job.id, ok: false, reason: `简历里缺 ${missing.join('、')}`, resume_plan: c.plan };
  }
  const app = c.existing ?? deps.repos.createApplication(c.job.id, c.plan.kind === 'tailored' ? c.resumeId : null);
  const action = deps.repos.enqueueAction('fill_form', { job_id: c.job.id, resume_id: c.resumeId, resume_plan: c.plan, application_id: app.id, url: c.job.url }, app.id);
  return { job_id: c.job.id, ok: true, action_id: action.id, resume_plan: c.plan };
}

/**
 * 逐个创建投递 + 排 fill_form（待审，由 applyJobs 当场批准）。已在投、已投过的跳过。毫秒级：不调模型、不导 PDF。
 * 有真 JD 的岗位记 resume_plan.kind=will_tailor，后台开跑前先按 JD 定制一版再冻结（packet-prepare.ts）。
 */
export async function prepareJobs(deps: PrepareDeps, jobIds: string[], resumeId?: string | null, opts: { fallbackResumeId?: string | null } = {}): Promise<PrepareResult[]> {
  const out: PrepareResult[] = [];
  for (const jobId of jobIds) {
    const c = candidateOf(deps, jobId, resumeId, opts.fallbackResumeId);
    out.push(typeof c === 'string' ? { job_id: jobId, ok: false, reason: c } : await enqueueCandidate(deps, c));
  }
  return out;
}
