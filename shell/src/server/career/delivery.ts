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

import { markedTargetJobs } from './targets';

/** 规范 §6.2 的底条状态；failed 只在出错时（红）。 */
export type PosterState = 'wait' | 'run' | 'done' | 'ask' | 'failed';
export interface RunPoster { application_id: string; job_id: string; role: string; company: CompanyMark; star: boolean; state: PosterState }
export interface RunView { total: number; done: number; running: number; asking: number; failed: number; items: RunPoster[] }

/** 投出之后的阶段：都算「已投出」（之后被拒也是投出过）。 */
const SENT_STAGES = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);
const TARGET_STAGES = new Set(['interview', 'offer', 'hired']);

function fillActions(repos: Repos, by: { since?: string; actionIds?: readonly string[] }): ActionQueueItem[] {
  if (by.actionIds?.length) {
    const ids = by.actionIds;
    return repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, [...ids]);
  }
  if (!by.since) return [];
  return repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind='fill_form' AND created_at >= ? ORDER BY created_at`, [by.since]);
}

function posterState(stage: string, actions: readonly ActionQueueItem[], asking: boolean): PosterState {
  if (SENT_STAGES.has(stage)) return 'done';
  if (asking) return 'ask';
  if (actions.some(a => a.status === 'executing' || (a.kind === 'submit' && a.status === 'approved'))) return 'run';
  if (stage === 'blocked' || actions.some(a => a.kind === 'fill_form' && a.status === 'failed')) return 'failed';
  return 'wait';
}

/** 一批申请的海报墙。目标岗位（进过面试、或用户亲手标的）排在前面，用大一档的海报。 */
export function buildRun(repos: Repos, by: { since?: string; actionIds?: readonly string[] }, asks: readonly AskView[] = buildAsks(repos, new Date().toISOString())): RunView | null {
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
export interface AwayView { since: string; asks: AskView[]; sent: CompanyMark[]; replies: ReplyFact[]; quiet: number }

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
  return { since, asks: buildAsks(repos, nowIso), sent: sent.map(s => companyMarkOf(s.company_name, s.company_id)), replies: replyFacts(repos, since), quiet };
}
