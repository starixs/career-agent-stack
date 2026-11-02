/**
 * 右栏的读模型（主线体验 §6.1a，11-02 定）：后台在做什么，全在右栏，不进对话。
 *
 * 一次读出右栏要的全部：主线走到哪一步、几个预设岗位块各自在做什么、等你的事、每份投递的回执、
 * 信任账本里「学会了」的几类、今天的三个数。只读现有的权威数据（经历、简历、投递、动作队列、
 * 批量运行器状态、邮箱、信任账本），不另存一份；前端按表变化重新拉。
 */
import type { Repos } from '@career/core';

import type { CoreModule } from './core-module';

import type { CareerStore } from './store';
import { BATCH_STATE_KEY, type BatchState } from './batch-runner';
import { getJobPrefs, jobBoard } from './job-board';
import { resumeMasterOf } from './packets';
import { readLedger, shouldProposeDelegate } from './trust-ledger';
import type { MainlineStage, RailBlock, RailPool, RailReceipt, RailSnapshot, RailWaiting, TrustEntry } from '../../shared/careerRail';

export type { MainlineStage, RailSnapshot } from '../../shared/careerRail';

/** 回执最多列几张：右栏是扫一眼的地方，完整记录在漏斗页。 */
const RECEIPT_LIMIT = 30;
const SENT_STAGES = ['applied', 'responded', 'interview', 'offer', 'rejected', 'hired'];
const WAITING_STATUSES = new Set(['needs_user', 'pending_review']);

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function mainlineStage(repos: Repos, store: CareerStore, sentCount: number, ledger: TrustEntry[]): MainlineStage {
  // 简历真的生成了才算建档完：聊出一两段经历还在建档里
  if (!store.listResumeMasters().length) return 'profile';
  if (!(getJobPrefs(repos).keywords ?? []).length && sentCount === 0) return 'direction';
  if (sentCount === 0) return 'first';
  return ledger.some(e => e.state === 'delegated') ? 'released' : 'batch';
}

function resumeBlock(repos: Repos, store: CareerStore, core: CoreModule): RailBlock {
  const masters = store.listResumeMasters();
  const experiences = repos.listExperiences().length;
  const interviewing = Object.values(repos.kvGet<{ rounds?: Record<string, string> }>(core.INTERVIEW_STATE_KEY)?.rounds ?? {}).includes('in_progress');
  // 简历一出来就算好了：访谈进度里留着没收尾的轮次，不该让右栏一直说「正在写」（2026-11-02 实例 A）
  if (masters.length) return { id: 'resume', label: '写简历', status: 'done', line: `简历好了：${masters[0].name}` };
  if (interviewing) return { id: 'resume', label: '写简历', status: 'working', line: `边聊边写，已经有 ${experiences} 段经历` };
  return { id: 'resume', label: '写简历', status: 'idle', line: '等你把简历给我，或者聊聊你做过的事' };
}

function tailorBlock(repos: Repos): RailBlock {
  const running = repos.listTasks('running').filter(t => t.kind === 'tailor');
  if (running.length) return { id: 'tailor', label: '定制', status: 'working', line: `在按岗位改简历：${running[0].title}` };
  const n = repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM resume_tailored')?.n ?? 0;
  return { id: 'tailor', label: '定制', status: n ? 'done' : 'idle', line: n ? `已经按岗位改了 ${n} 份` : '定好方向后，按每个岗位改一版' };
}

function applyBlock(repos: Repos, sent: number): RailBlock {
  const batch = repos.kvGet<BatchState>(BATCH_STATE_KEY);
  const actions = repos.listActions().filter(a => a.kind === 'fill_form');
  const waiting = actions.filter(a => a.status === 'needs_user').length;
  const failed = actions.filter(a => a.status === 'failed').length;
  const held = repos.listActions('pending_review').filter(a => a.kind === 'submit').length;
  const running = batch?.status === 'running' ? (batch.running ?? []) : [];
  const total = actions.length;
  const base = { id: 'apply' as const, label: '网申', done: sent, total };
  if (running.length) return { ...base, status: 'working', line: `在填：${running.map(r => r.title).join('、')}` };
  if (waiting) return { ...base, status: 'waiting', line: `${waiting} 份等你一下` };
  if (held) return { ...base, status: 'waiting', line: `${held} 份填好了，停在提交前等你点头` };
  // 填表没成：如实说，不当成完成（2026-11-02 实例 A：失败曾显示成「投出 0 份」）
  if (failed) return { ...base, status: 'waiting', line: `${failed} 份没填成，我在查原因${sent ? `；已投出 ${sent} 份` : ''}` };
  if (total) return { ...base, status: 'done', line: `投出 ${sent} 份` };
  return { id: 'apply', label: '网申', status: 'idle', line: '简历和方向好了就开始' };
}

function mailBlock(repos: Repos): RailBlock {
  const accounts = repos.listMailAccounts();
  if (!accounts.length) return { id: 'mail', label: '盯邮箱', status: 'idle', line: '投出去之后，连上邮箱我替你盯回音' };
  return { id: 'mail', label: '盯邮箱', status: 'working', line: `在盯 ${accounts[0].address}，有动静叫你` };
}

function receipts(repos: Repos): RailReceipt[] {
  const placeholders = SENT_STAGES.map(() => '?').join(',');
  const rows = repos.db.all<{ application_id: string; company: string | null; title: string; at: string; payload_json: string | null }>(
    `SELECT a.id AS application_id, j.company_name AS company, j.title AS title, MIN(h.created_at) AS at,
            (SELECT q.payload_json FROM action_queue q WHERE q.application_id = a.id AND q.kind = 'submit' AND q.status = 'done' ORDER BY q.updated_at DESC LIMIT 1) AS payload_json
       FROM application a JOIN job j ON j.id = a.job_id
       JOIN application_history h ON h.application_id = a.id AND h.to_stage = 'applied'
      WHERE a.stage IN (${placeholders})
      GROUP BY a.id ORDER BY at DESC LIMIT ?`, [...SENT_STAGES, RECEIPT_LIMIT]);
  return rows.map(r => ({ application_id: r.application_id, company: r.company ?? '未知公司', title: r.title, at: r.at, ...submitSummary(repos, r.payload_json) }));
}

/** 回执里的两样：这份交出去用的是哪版简历（材料包），填了几格（提交那一步记下的填表摘要）。 */
function submitSummary(repos: Repos, payloadJson: string | null): { resume: string | null; filled: number | null } {
  if (!payloadJson) return { resume: null, filled: null };
  try {
    const payload = JSON.parse(payloadJson) as { packet_id?: unknown; summary?: { filled?: unknown } };
    const packet = typeof payload.packet_id === 'string' ? repos.getPacket(payload.packet_id) : undefined;
    const resume = packet?.resume_id ? resumeMasterOf(repos, packet.resume_id)?.name ?? null : null;
    return { resume, filled: typeof payload.summary?.filled === 'number' ? payload.summary.filled : null };
  } catch (error) {
    console.warn('[career] rail: 提交记录解析失败', error instanceof Error ? error.message : error);
    return { resume: null, filled: null };
  }
}

function waiting(repos: Repos): RailWaiting {
  const handoffs = repos.openHandoffs();
  const actions = repos.listActions().filter(a => WAITING_STATUSES.has(a.status));
  const count = handoffs.length + actions.length;
  const first = handoffs[0]
    ? { title: '这一步要你本人来', detail: handoffs[0].message ?? null }
    : actions[0] ? { title: actions[0].status === 'needs_user' ? '补一下信息' : '过目一下再交', detail: null } : null;
  return { count, first };
}

/** 岗位池：没截止的岗位里有几个符合他说过的条件（本地查询，不过模型，所以能当场变）。 */
function pool(repos: Repos): RailPool {
  const open = jobBoard(repos, { open_only: true });
  const p = getJobPrefs(repos);
  const keywords = (p.keywords ?? []).map(k => k.toLowerCase());
  const mentions = (r: (typeof open)[number]) => !keywords.length || keywords.some(k => `${r.job.title} ${r.job.jd_raw ?? ''}`.toLowerCase().includes(k));
  const fits = open.filter(r => r.match?.hard_ok !== false && mentions(r)).length;
  const conditions = [...(p.keywords ?? []), ...(p.cities ?? []), p.cohort ? (p.cohort.endsWith('届') ? p.cohort : `${p.cohort} 届`) : null, p.degree].filter((c): c is string => !!c);
  return { total: open.length, fits: conditions.length ? fits : open.length, conditions };
}

export function railSnapshot(repos: Repos, store: CareerStore, core: CoreModule): RailSnapshot {
  const ledger = Object.values(readLedger(repos)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const list = receipts(repos);
  const since = startOfToday();
  const wait = waiting(repos);
  // 备好 = 填好了、停在提交前、点一下就交的份数（预准备备出来的也在这里）
  const prepared = repos.listActions('pending_review').filter(a => a.kind === 'submit').length;
  return {
    stage: mainlineStage(repos, store, list.length, ledger),
    blocks: [resumeBlock(repos, store, core), tailorBlock(repos), applyBlock(repos, list.length), mailBlock(repos)],
    waiting: wait,
    receipts: list,
    learned: ledger.map(e => ({ ...e, propose: shouldProposeDelegate(e) })),
    today: { prepared, sent: list.filter(r => r.at >= since).length, waiting: wait.count },
    pool: pool(repos),
  };
}
