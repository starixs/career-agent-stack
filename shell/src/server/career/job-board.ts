/**
 * 岗位汇总表（R01 校招与实习网申汇总 / R02 依据简历找匹配岗位 / R06 勾选加入待投清单）。
 *
 *  - 求职条件 kv `profile.job_prefs`（届别 / 学历 / 城市 / 类型 / 方向词），推荐不得违反。
 *  - 匹配证据：已确认的经历主张 + 主简历（及定制版）里的条目文字；`matchJob` 逐条要求对证据，结果存 job.match_json / match_score。
 *  - 汇总表：岗位 + 我的进度（投递阶段）+ 匹配，按筛选条件与排序给出。
 *  - 加入待投清单：对勾选的岗位逐个 apply_prepare（冻结材料包 + fill_form 待审）。
 */
import { JOB_PREFS_KEY, matchJob, type Job, type JobMatch, type JobPrefs, type MatchEvidence, type Repos } from '@career/core';

import { freezePacket, pickResumeForJob, type PacketDeps } from './packets';
import type { CareerStore } from './store';

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
}
export interface BoardMeta { batch: string | null; industry: string | null; type_tags: string[] }

/** 校招来源把「央国企 / 外企 / 事业单位」这类企业性质也写在行业里：归到类型标签，行业只留真正的行业。 */
const OWNERSHIP_RE = /央企|国企|央国企|外企|外资|合资|民企|事业单位|研究所|军工/;

/** 来源数据里的维度：campus-radar 导入时写在 prefilter_json.campus（见 bridges/campusRadar.ts mapCampusJob）。 */
export function boardMeta(job: Pick<Job, 'prefilter_json'>): BoardMeta {
  let campus: Record<string, unknown> = {};
  try {
    const raw = job.prefilter_json ? JSON.parse(job.prefilter_json) as Record<string, unknown> : {};
    if (raw && typeof raw.campus === 'object' && raw.campus) campus = raw.campus as Record<string, unknown>;
  } catch { /* 坏 JSON 当没有 */ }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '其他' ? v.trim() : null);
  const industryRaw = text(campus.industry);
  const ownership = industryRaw && OWNERSHIP_RE.test(industryRaw);
  return {
    batch: text(campus.batch),
    industry: ownership ? null : industryRaw,
    type_tags: ownership && industryRaw ? [industryRaw] : [],
  };
}

const DONE = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired', 'skip']);

export function jobBoard(repos: Repos, f: BoardFilter = {}, today = new Date().toISOString().slice(0, 10)): BoardRow[] {
  const apps = new Map<string, BoardRow['application']>();
  for (const a of repos.listApplications()) if (!apps.has(a.job_id)) apps.set(a.job_id, { id: a.id, stage: a.stage, next_action: a.next_action, updated_at: a.updated_at });
  const q = f.q?.trim().toLowerCase();
  let rows: BoardRow[] = repos.listJobs().filter(j => j.source_status !== 'merged').map(job => ({ job, match: parseMatch(job.match_json), application: apps.get(job.id) ?? null, meta: boardMeta(job) }));
  rows = rows.filter(({ job, match, application }) => {
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

/** 勾选的岗位加入待投清单：逐个创建投递 + 冻结材料包 + fill_form 待审。已在进行中的跳过。 */
export async function prepareJobs(deps: PacketDeps & { store: CareerStore }, jobIds: string[], resumeId?: string | null): Promise<Array<{ job_id: string; ok: boolean; action_id?: string; reason?: string }>> {
  const out: Array<{ job_id: string; ok: boolean; action_id?: string; reason?: string }> = [];
  for (const jobId of jobIds) {
    const job = deps.repos.getJob(jobId);
    if (!job) { out.push({ job_id: jobId, ok: false, reason: '岗位不存在' }); continue; }
    const existing = deps.repos.listApplications().find(a => a.job_id === jobId && !DONE.has(a.stage));
    if (existing && deps.repos.listActions().some(a => a.application_id === existing.id && ['pending_review', 'approved', 'executing', 'needs_user'].includes(a.status))) { out.push({ job_id: jobId, ok: false, reason: '已在待投清单或正在投' }); continue; }
    if (!job.url) { out.push({ job_id: jobId, ok: false, reason: '没有网申链接' }); continue; }
    const picked = pickResumeForJob(deps.store, jobId, resumeId);
    if (!picked) { out.push({ job_id: jobId, ok: false, reason: '有多份主简历，请先选这次投哪一份' }); continue; }
    const app = existing ?? deps.repos.createApplication(jobId, picked.kind === 'tailored' ? picked.id : null);
    const { packet, warning } = await freezePacket(deps, { applicationId: app.id, jobId, resumeId: picked.id });
    const action = deps.repos.enqueueAction('fill_form', { job_id: jobId, resume_id: picked.id, packet_id: packet.id, application_id: app.id, url: job.url }, app.id);
    out.push({ job_id: jobId, ok: true, action_id: action.id, ...(warning ? { reason: warning } : {}) });
  }
  return out;
}
