/**
 * 右栏的读模型（主线体验 §6.1a，11-02 定）：后台在做什么，全在右栏，不进对话。
 *
 * 一次读出右栏要的全部：主线走到哪一步、几个预设岗位块各自在做什么、等你的事、每份投递的回执、
 * 信任账本里「学会了」的几类、今天的三个数。只读现有的权威数据（经历、简历、投递、动作队列、
 * 批量运行器状态、邮箱、信任账本），不另存一份；前端按表变化重新拉。
 */
import { isFillRetrying, type ApplicationPacket, type Repos } from '@career/core';

import type { CoreModule } from './core-module';

import type { CareerStore } from './store';
import { BATCH_STATE_KEY, type BatchState } from './batch-runner';
import { isDraftingMail, isHeldAction, isHeldMail, isStartAction } from './apply-actions';
import { asksFor } from './delivery';
import { getJobPrefs, jobBoard } from './job-board';
import { packetResumePlan, resumeMasterOf, tailoredChangeCount } from './packets';
import { readLedger, shouldProposeDelegate } from './trust-ledger';
import { SUBMITTED_STAGES } from '../../shared/careerStages';
import type { MainlineStage, RailBlock, RailPool, RailReceipt, RailSnapshot, RailWaiting, TrustEntry } from '../../shared/careerRail';

export type { MainlineStage, RailSnapshot } from '../../shared/careerRail';

/** 回执最多列几张：右栏是扫一眼的地方，完整记录在漏斗页。 */
const RECEIPT_LIMIT = 30;
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
  return { id: 'resume', label: '写简历', status: 'idle', line: '还没有简历' };
}

function tailorBlock(repos: Repos, since: string): RailBlock {
  const running = repos.listTasks('running').filter(t => t.kind === 'tailor');
  if (running.length) return { id: 'tailor', label: '定制', status: 'working', line: `在按岗位改简历：${running[0].title}` };
  const count = repos.db.get<{ n: number; today: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today FROM resume_tailored', [since]);
  const n = count?.n ?? 0;
  const today = count?.today ?? 0;
  return { id: 'tailor', label: '定制', status: n ? 'done' : 'idle', line: n ? `按岗位改了 ${n} 份 · 今天 ${today}` : '还没改过' };
}

/** 停在发出前等他点头的那一行：全是邮件说邮件，全是网申说提交前，混着说备好了。 */
function heldLine(repos: Repos): string | null {
  const held = repos.listActions('pending_review').filter(isHeldAction);
  if (!held.length) return null;
  const mails = held.filter(isHeldMail).length;
  if (mails === held.length) return `${mails} 封邮件写好了，等你过目`;
  return mails ? `${held.length} 份备好了，等你点头` : `${held.length} 份填好了，停在提交前`;
}

function applyBlock(repos: Repos, sent: number): RailBlock {
  const batch = repos.kvGet<BatchState>(BATCH_STATE_KEY);
  // 一份投递开始的那一步：网申填表、写投递邮件（apply-actions.ts）
  const actions = repos.listActions().filter(isStartAction);
  const waiting = actions.filter(a => a.status === 'needs_user').length;
  const retrying = actions.filter(a => isFillRetrying(repos, a)).length;
  const drafting = actions.filter(isDraftingMail).length;
  const held = heldLine(repos);
  const running = batch?.status === 'running' ? (batch.running ?? []) : [];
  const base = { id: 'apply' as const, label: '网申' };
  // 不给分数：已投是累计、填表动作是全部，「20/8」读不懂（r3 C4）；今天投出几份在下面那行。
  // 没填成的先自动再试一次：如实说在再试（2026-11-02 实例 A：失败曾显示成「投出 0 份」）；再试也没成的进「等你」，这里不再说
  const retryLine = retrying ? `${retrying} 份没填成，正在再试一次` : '';
  // 第一次要先准备浏览器（下载约 1–2 分钟）：直接说要等多久，不然像卡死（风险 E#2）
  if (batch?.status === 'running' && batch.phase === 'browser_down' && batch.message) return { ...base, status: 'working', line: batch.message };
  if (running.length) return { ...base, status: 'working', line: [`在填：${running.map(r => r.title).join('、')}`, retryLine].filter(Boolean).join('；') };
  if (retrying) return { ...base, status: 'working', line: retryLine };
  if (drafting) return { ...base, status: 'working', line: `在写 ${drafting} 封投递邮件` };
  if (waiting) return { ...base, status: 'waiting', line: `${waiting} 份要你补一下` };
  if (held) return { ...base, status: 'waiting', line: held };
  if (sent) return { ...base, status: 'done', line: `投出 ${sent} 份` };
  return { ...base, status: 'idle', line: actions.length ? '还没投出' : '还没开始' };
}

function mailBlock(repos: Repos): RailBlock {
  const accounts = repos.listMailAccounts();
  if (!accounts.length) return { id: 'mail', label: '盯邮箱', status: 'idle', line: '还没连邮箱' };
  return { id: 'mail', label: '盯邮箱', status: 'working', line: `在盯 ${accounts[0].address}` };
}

export function receipts(repos: Repos): RailReceipt[] {
  const placeholders = SUBMITTED_STAGES.map(() => '?').join(',');
  const rows = repos.db.all<{ application_id: string; company: string | null; title: string; at: string; payload_json: string | null }>(
    `SELECT a.id AS application_id, j.company_name AS company, j.title AS title, MIN(h.created_at) AS at,
            (SELECT q.payload_json FROM action_queue q WHERE q.application_id = a.id AND q.kind = 'submit' AND q.status = 'done' ORDER BY q.updated_at DESC LIMIT 1) AS payload_json
       FROM application a JOIN job j ON j.id = a.job_id
       JOIN application_history h ON h.application_id = a.id AND h.to_stage = 'applied'
      WHERE a.stage IN (${placeholders})
      GROUP BY a.id ORDER BY at DESC LIMIT ?`, [...SUBMITTED_STAGES, RECEIPT_LIMIT]);
  return rows.map(r => ({ application_id: r.application_id, company: r.company ?? '未知公司', title: r.title, at: r.at, ...submitSummary(repos, r.payload_json) }));
}

type ReceiptResume = Pick<RailReceipt, 'resume' | 'resume_kind' | 'changes' | 'filled'>;
const NO_RESUME: ReceiptResume = { resume: null, resume_kind: null, changes: null, filled: null };

/** 材料包里记下的定制改动数（answers_json.resume_plan.changes）；老材料包没有就现算。 */
function packetChanges(repos: Repos, packet: ApplicationPacket): number | null {
  return packetResumePlan(repos, packet.id)?.changes ?? (packet.resume_id ? tailoredChangeCount(repos, packet.resume_id) : null);
}

/**
 * 回执里的几样：这份交出去用的是哪版简历（材料包：定制版还是主简历、定制版改了几处），填了几格（提交那一步记下的填表摘要）。
 * 定制版不写成主简历名（此前 resumeMasterOf 对定制版也返回主简历名，回执就成了「用的「主简历」」）。
 */
function submitSummary(repos: Repos, payloadJson: string | null): ReceiptResume {
  if (!payloadJson) return NO_RESUME;
  try {
    const payload = JSON.parse(payloadJson) as { packet_id?: unknown; summary?: { filled?: unknown } };
    const packet = typeof payload.packet_id === 'string' ? repos.getPacket(payload.packet_id) : undefined;
    const filled = typeof payload.summary?.filled === 'number' ? payload.summary.filled : null;
    if (!packet?.resume_id) return { ...NO_RESUME, filled };
    const resume = resumeMasterOf(repos, packet.resume_id)?.name ?? null;
    const tailored = packet.resume_kind === 'tailored';
    return { resume, resume_kind: tailored ? 'tailored' : 'master', changes: tailored ? packetChanges(repos, packet) : null, filled };
  } catch (error) {
    console.warn('[career] rail: 提交记录解析失败', error instanceof Error ? error.message : error);
    return NO_RESUME;
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
  // 备好 = 填好了停在提交前 / 邮件写好了等发、点一下就交的份数（预准备备出来的也在这里）
  const prepared = repos.listActions('pending_review').filter(isHeldAction).length;
  return {
    stage: mainlineStage(repos, store, list.length, ledger),
    blocks: [resumeBlock(repos, store, core), tailorBlock(repos, since), applyBlock(repos, list.length), mailBlock(repos)],
    waiting: wait,
    receipts: list,
    learned: ledger.map(e => ({ ...e, propose: shouldProposeDelegate(e) })),
    // 「等你」和输入框上沿的等你条同一个来源（asksFor），两处的数永远对得上
    today: { prepared, sent: list.filter(r => r.at >= since).length, waiting: asksFor(repos).length },
    pool: pool(repos),
  };
}
