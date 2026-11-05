/**
 * 投递切面的数据（服务端 /api/career/asks · run · away，结构同 @career/core AskView / CompanyMark 与 server/career/delivery.ts）。
 * 合并与排序由服务端裁决，前端只渲染；跨边界数据在这里过一遍形状校验，形状不对的条目丢掉并留日志，不猜字段。
 */
import { apiGetJson, apiPostJson } from '@/api/apiFetch';

export interface CompanyMark { company_id: string | null; name: string; logo?: string; fill?: string }
export type AskKind = 'info' | 'login' | 'deadline' | 'slot' | 'review' | 'start' | 'confirm' | 'attendance' | 'retro' | 'failed' | 'unsure';
export interface AskField { label: string; /** 给人看的说法（去掉问卷题号）；老数据没有就用 label */ text?: string; vault_field: string | null; sensitive: boolean; fillable: boolean; /** 网页上的可选项（下拉 / 单选） */ options?: string[]; /** 小芽写好的一版（开放题），卡片里预填 */ draft?: string }
export interface AskView {
  id: string; kind: AskKind; title: string; detail?: string; role?: string;
  application_ids: string[]; companies: CompanyMark[]; sources: Array<{ type: 'deadline' | 'action' | 'handoff'; id: string }>; action_ids?: string[];
  due_at: string | null; overdue: boolean; deadline_kind?: string; url?: string | null;
  source?: { inbox_item_id: string; received_at: string };
  fields?: AskField[]; review?: { required_filled: number | null; required_total: number | null; gaps: number }; suggest?: string;
}
export type PosterState = 'wait' | 'run' | 'done' | 'ask' | 'failed' | 'next';
export interface RunPoster { application_id: string; job_id: string; role: string; company: CompanyMark; star: boolean; state: PosterState }
export interface RunView { total: number; done: number; running: number; asking: number; failed: number; items: RunPoster[] }
export interface ReplyFact { kind: 'interview' | 'exam' | 'rejection' | 'offer'; label: string; n: number; companies: CompanyMark[] }
export interface AwayView { since: string; asks: AskView[]; sent: CompanyMark[]; replies: ReplyFact[]; quiet: number; /** 替你挡掉的：填好了停在提交前、没你点头不交 */ held: number }

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const ASK_KINDS: ReadonlySet<string> = new Set(['info', 'login', 'deadline', 'slot', 'review', 'start', 'confirm', 'attendance', 'retro', 'failed', 'unsure']);

export function isCompanyMark(v: unknown): v is CompanyMark {
  return isDict(v) && isStr(v.name) && (v.logo === undefined || isStr(v.logo)) && (v.fill === undefined || isStr(v.fill));
}
export function isAskView(v: unknown): v is AskView {
  return isDict(v) && isStr(v.id) && isStr(v.kind) && ASK_KINDS.has(v.kind) && isStr(v.title)
    && Array.isArray(v.application_ids) && Array.isArray(v.sources) && Array.isArray(v.companies) && v.companies.every(isCompanyMark)
    && (v.due_at === null || isStr(v.due_at)) && typeof v.overdue === 'boolean';
}
function isRunView(v: unknown): v is RunView {
  return isDict(v) && typeof v.total === 'number' && typeof v.done === 'number' && Array.isArray(v.items)
    && v.items.every(i => isDict(i) && isStr(i.application_id) && isStr(i.role) && isCompanyMark(i.company) && isStr(i.state));
}

/** 只留形状对的条目；丢掉的留一条日志（带 id），方便对照服务端。 */
export function parseAsks(raw: unknown): AskView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(a => {
    if (isAskView(a)) return true;
    console.warn('[career] delivery: 丢弃形状不对的 AskView', isDict(a) ? a.id : a);
    return false;
  });
}
export const parseRun = (raw: unknown): RunView | null => (isRunView(raw) ? raw : null);
function parseAway(raw: unknown): AwayView | null {
  if (!isDict(raw) || !isStr(raw.since) || !Array.isArray(raw.sent) || !Array.isArray(raw.replies) || typeof raw.quiet !== 'number') return null;
  const replies = raw.replies.filter((r): r is ReplyFact => isDict(r) && isStr(r.label) && typeof r.n === 'number' && Array.isArray(r.companies) && r.companies.every(isCompanyMark));
  return { since: raw.since, asks: parseAsks(raw.asks), sent: raw.sent.filter(isCompanyMark), replies, quiet: raw.quiet, held: typeof raw.held === 'number' ? raw.held : 0 };
}

const field = (res: unknown, key: string): unknown => (isDict(res) ? res[key] : undefined);

export const deliveryApi = {
  /** since = 本地零点：今天这批的进度。 */
  asks: (since: string) => apiGetJson<unknown>(`/api/career/asks?since=${encodeURIComponent(since)}`)
    .then(r => ({ asks: parseAsks(field(r, 'asks')), run: parseRun(field(r, 'run')) })),
  run: (actionIds: readonly string[]) => apiGetJson<unknown>(`/api/career/run?action_ids=${encodeURIComponent(actionIds.join(','))}`).then(r => parseRun(field(r, 'run'))),
  /** 缺信息填一次：服务端存进本机（不经过模型），整批交给后台接着填。still_waiting > 0 = 还有只能在页面上看的项。 */
  fill: (askId: string, values: Record<string, string>) => apiPostJson<unknown>(`/api/career/asks/${encodeURIComponent(askId)}/fill`, { values })
    .then(r => ({ stillWaiting: typeof field(r, 'still_waiting') === 'number' ? field(r, 'still_waiting') as number : 0 })),
  /** 一家一家带你登录（服务端按 Cookie / 登录接口返回判断登上没有）；cancel 停下，剩下的留在等你条里。 */
  loginJourney: (askId: string, cancel = false) => apiPostJson<unknown>(`/api/career/asks/${encodeURIComponent(askId)}/login-journey`, cancel ? { cancel: true } : {}),
  /** 「N 家没填成」再试一次：整件放回队列，后台只填这几份。 */
  retryFailed: (askId: string) => apiPostJson<unknown>(`/api/career/asks/${encodeURIComponent(askId)}/retry`, {}),
  /** 「N 家没填成」我自己来：开接管，现场画面切到那一家（不传就是第一家）。 */
  takeOverFailed: (askId: string, applicationId?: string) => apiPostJson<unknown>(`/api/career/asks/${encodeURIComponent(askId)}/self`, applicationId ? { application_id: applicationId } : {}),
  away: (since: string) => apiGetJson<unknown>(`/api/career/away?since=${encodeURIComponent(since)}`).then(r => parseAway(field(r, 'away'))),
};

/** 客户端本地零点（ISO）：服务端不猜时区。 */
export function localMidnightIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
