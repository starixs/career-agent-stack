/**
 * 投递切面的两张图的数据（规范 CAREER_INTELLIGENT_UI.md §5.5 批次卡、§5.6 回来卡）。
 *
 *  - 批次（RunView）：一批申请各自走到哪了。一张批次卡按「这句话开的那几份」（填表动作 id）取；
 *    等你条右边的「投出 x / y」按「今天开始投的」（since = 客户端本地零点）取。
 *  - 回来（AwayView）：离开期间投出了哪些、来了哪些回音（按类计数 + 公司）、其余几家没回音，
 *    外加现在要你的事（和等你条是同一份 buildAsks，页面上刚处理掉的自然不在）。
 *
 * 状态只读不写；颜色和文字由前端按 state 定，这里不出文案以外的展示判断。
 */
import { buildAsks, companyMarkOf, type ActionQueueItem, type AskView, type CompanyMark, type InboxItem, type Repos } from '@career/core';

import { isSubmittedStage } from '../../shared/careerStages';
import { isHeldAction, isStartAction, START_KINDS } from './apply-actions';
import { isTargetApplication, markedTargetJobs } from './targets';

/** 现在要你的事：core 的合并规则 + 目标星（目标岗位的提交不并进「一键投出」）。壳层一律用它，不直接调 buildAsks。 */
export function asksFor(repos: Repos, nowIso = new Date().toISOString()): AskView[] {
  const marked = markedTargetJobs(repos);
  return buildAsks(repos, nowIso, { isTarget: id => isTargetApplication(repos, id, marked) });
}

/** 规范 §6.2 的底条状态；failed 只在出错时（红）。 */
export type PosterState = 'wait' | 'run' | 'done' | 'ask' | 'failed';
export interface RunPoster { application_id: string; job_id: string; role: string; company: CompanyMark; star: boolean; state: PosterState }
export interface RunView { total: number; done: number; running: number; asking: number; failed: number; items: RunPoster[] }

const TARGET_STAGES = new Set(['interview', 'offer', 'hired']);

function fillActions(repos: Repos, by: { since?: string; actionIds?: readonly string[] }): ActionQueueItem[] {
  if (by.actionIds?.length) {
    const ids = by.actionIds;
    return repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, [...ids]);
  }
  if (!by.since) return [];
  // 今天开始投的：网申填表与写投递邮件都算（apply-actions.ts START_KINDS）
  const kinds = [...START_KINDS];
  return repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind IN (${kinds.map(() => '?').join(',')}) AND created_at >= ? ORDER BY created_at`, [...kinds, by.since]).filter(isStartAction);
}

/** 交出去那一步正在进行：提交 / 发邮件已批准、在执行。 */
const isSending = (a: ActionQueueItem) => (a.kind === 'submit' || a.kind === 'send_mail') && a.status === 'approved';
/** 这份投递的在办动作失败了：填表、写邮件、发邮件。 */
const isFailedStep = (a: ActionQueueItem) => (isStartAction(a) || a.kind === 'send_mail') && a.status === 'failed';

function posterState(stage: string, actions: readonly ActionQueueItem[], asking: boolean): PosterState {
  if (isSubmittedStage(stage)) return 'done';
  if (asking) return 'ask';
  if (actions.some(a => a.status === 'executing' || isSending(a))) return 'run';
  if (stage === 'blocked' || actions.some(isFailedStep)) return 'failed';
  return 'wait';
}

/** 一批申请的海报墙。目标岗位（进过面试、或用户亲手标的）排在前面，用大一档的海报。 */
export function buildRun(repos: Repos, by: { since?: string; actionIds?: readonly string[] }, asks: readonly AskView[] = asksFor(repos)): RunView | null {
  const appIds = [...new Set(fillActions(repos, by).map(a => a.application_id).filter((x): x is string => !!x))];
  if (!appIds.length) return null;
  const asking = new Set(asks.flatMap(a => a.application_ids));
  const marked = markedTargetJobs(repos);
  const items: RunPoster[] = [];
  for (const id of appIds) {
    const app = repos.getApplication(id);
    const job = app ? repos.getJob(app.job_id) : undefined;
    if (!app || !job) continue;
    const actions = repos.db.all<ActionQueueItem>('SELECT * FROM action_queue WHERE application_id=?', [id]);
    items.push({
      application_id: id, job_id: job.id, role: job.title, company: companyMarkOf(job.company_name, job.company_id),
      star: marked.has(job.id) || TARGET_STAGES.has(app.stage), state: posterState(app.stage, actions, asking.has(id)),
    });
  }
  items.sort((a, b) => Number(b.star) - Number(a.star));
  const count = (s: PosterState) => items.filter(i => i.state === s).length;
  return { total: items.length, done: count('done'), running: count('run'), asking: count('ask'), failed: count('failed'), items };
}

// ---------- 回来卡 ----------

export interface ReplyFact { kind: 'interview' | 'exam' | 'rejection' | 'offer'; label: string; n: number; companies: CompanyMark[] }
export interface AwayView { since: string; asks: AskView[]; sent: CompanyMark[]; replies: ReplyFact[]; quiet: number; /** 填好了停在提交前、等他点头的份数 */ held: number }

const REPLY_OF: Partial<Record<string, { kind: ReplyFact['kind']; label: string }>> = {
  interview_invite: { kind: 'interview', label: '面试邀请' },
  assessment: { kind: 'exam', label: '笔试 / 测评' },
  written_test: { kind: 'exam', label: '笔试 / 测评' },
  rejection: { kind: 'rejection', label: '不合适' },
  offer: { kind: 'offer', label: 'Offer' },
};
const REPLY_ORDER: ReadonlyArray<ReplyFact['kind']> = ['offer', 'interview', 'exam', 'rejection'];

/** 一封信连到的是哪份申请（直接连申请，或经由面试、截止）。 */
function inboxApplication(repos: Repos, item: InboxItem): string | null {
  if (item.linked_type === 'application') return item.linked_id;
  if (item.linked_type === 'interview' && item.linked_id) return repos.db.get<{ application_id: string | null }>('SELECT application_id FROM interview WHERE id=?', [item.linked_id])?.application_id ?? null;
  if (item.linked_type === 'deadline' && item.linked_id) return repos.getDeadline(item.linked_id)?.application_id ?? null;
  return null;
}

/** 一封信是哪家公司的：顺着它连到的申请找；连不上的用归类时抽出的公司名。 */
function inboxCompany(repos: Repos, item: InboxItem): string | null {
  const appId = inboxApplication(repos, item);
  const app = appId ? repos.getApplication(appId) : undefined;
  const job = app ? repos.getJob(app.job_id) : undefined;
  if (job?.company_name) return job.company_name;
  try {
    const parsed = JSON.parse(item.parsed_json ?? '{}') as { fields?: { company?: unknown } };
    return typeof parsed.fields?.company === 'string' ? parsed.fields.company : null;
  } catch (e) {
    console.warn(`[career] away: inbox ${item.id} parsed_json 解析失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function replyFacts(repos: Repos, since: string): ReplyFact[] {
  const facts = new Map<ReplyFact['kind'], { label: string; names: string[] }>();
  for (const item of repos.listInbox()) {
    const kind = item.kind ? REPLY_OF[item.kind] : undefined;
    if (!kind || item.created_at < since || item.status === 'dismissed') continue;
    const f = facts.get(kind.kind) ?? { label: kind.label, names: [] };
    f.names.push(inboxCompany(repos, item) ?? '未知公司');
    facts.set(kind.kind, f);
  }
  return REPLY_ORDER.filter(k => facts.has(k)).map(k => {
    const f = facts.get(k)!;
    return { kind: k, label: f.label, n: f.names.length, companies: [...new Set(f.names)].map(n => companyMarkOf(n)) };
  });
}

/** 离开以后：投出了哪些、来了哪些回音、还有几家没回音；要你的事和等你条同一份。 */
export function buildAway(repos: Repos, since: string, nowIso = new Date().toISOString()): AwayView {
  const sent = repos.db.all<{ company_name: string | null; company_id: string | null }>(
    `SELECT DISTINCT j.company_name, j.company_id FROM application_history h JOIN application a ON a.id = h.application_id JOIN job j ON j.id = a.job_id
     WHERE h.to_stage = 'applied' AND h.created_at >= ? ORDER BY h.created_at`, [since]);
  // 没回音：投出后停在「已投递」、也没有任何来信或期限挂在它身上（笔试邀请不一定推进阶段）
  const heard = new Set([...repos.listInbox().map(i => inboxApplication(repos, i)), ...repos.listDeadlines().map(d => d.application_id)]);
  const quiet = repos.db.all<{ id: string }>(`SELECT id FROM application WHERE stage = 'applied'`).filter(a => !heard.has(a.id)).length;
  // 替你挡掉的（主线体验 §6.8，X 调研：让他看见闸门在起作用）：你不在时填好、停在提交前、没你点头不交的
  const held = repos.listActions('pending_review').filter(a => isHeldAction(a) && a.created_at >= since).length;
  return { since, asks: asksFor(repos, nowIso), sent: sent.map(s => companyMarkOf(s.company_name, s.company_id)), replies: replyFacts(repos, since), quiet, held };
}
