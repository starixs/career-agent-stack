/**
 * 要你的事（asks.ts）的形状与派生共用的小工具：AskView 合同、申请上下文（公司 / 岗位 / 截止）、解析 JSON 的容错。
 * 拆出来是为了让各类派生（网申、邮件）分文件写，又不互相引用。
 */
import { companyMarkOf, type CompanyMark } from './company-mark.js'
import type { Repos } from './repos.js'

/**
 * 规范五类 + 已经在今日队列里的四类（过了时间问「考了吗」、面完复盘、不确定是否投出、还没开始填的）。
 * 出错面：failed「N 家没填成」——填表失败、自动再试一次也没成的（fill-retry.ts），合成一件，「再试一次」一起放回队列。
 * 邮件投递：failed 也装「N 封没发出去」「N 封没写成」（asks-mail.ts）。
 * unsure「这几封我不太确定」仍是预留，现在不派生。
 */
export type AskKind = 'info' | 'login' | 'choice' | 'deadline' | 'slot' | 'review' | 'start' | 'confirm' | 'attendance' | 'retro' | 'failed' | 'unsure'
export type AskSourceType = 'deadline' | 'action' | 'handoff'
export interface AskSource { type: AskSourceType; id: string }
export interface AskField {
  label: string; /** 给人看的说法：去掉问卷题号「3.」和结尾冒号（label 仍是回填页面用的键） */ text: string; /** 能在卡片里填时写进私密库的字段；null = 写答案库 */ vault_field: string | null; sensitive: boolean; /** 上传类、读回不一致等只能去页面上看的项 */ fillable: boolean
  /** 网页上这一格的可选项（下拉 / 单选）：卡片里让他点选，不用猜网站的写法 */
  options?: string[]
  /** 小芽已经写好的一版（开放题草稿）：卡片里预填，他看一眼确认或改几个字，不从空白开始写 */
  draft?: string
}

/** 邮件是干什么的（与壳层 shared/careerMailApply.ts 的 MailPurpose 同形；core 不引壳层）。 */
export type AskMailPurpose = 'apply' | 'followup' | 'reply'
export const ASK_MAIL_PURPOSES: readonly AskMailPurpose[] = ['apply', 'followup', 'reply']
/** AskView.mail：这件事是「发邮件前过目」。只有用途和动作 id，没有邮件内容（明文只走专用接口）。 */
export interface AskMail {
  purpose: AskMailPurpose
  action_ids: string[]
  /** 上一封被退回了：改好收件人重发。 */
  bounced?: boolean
}
/** AskView.mail_failed：failed 那件是邮件的失败。draft = 没写成；send = 没发出去（reauth = 邮箱授权失效，要重新连邮箱）。 */
export interface AskMailFailed { stage: 'draft' | 'send'; reauth: boolean }

export interface AskView {
  id: string
  kind: AskKind
  /** ≤ 12 字左右，如「证件号码」「九方云 · 在线测评」 */
  title: string
  detail?: string
  /** 一个动作能解决的所有申请 */
  application_ids: string[]
  /** 只涉及一份申请时的岗位名（大海报下半写它） */
  role?: string
  /** 涉及的公司（与 application_ids 同序去重；没有申请的截止按标题里的公司名） */
  companies: CompanyMark[]
  /** 合并前的每个源；处理时逐个落库 */
  sources: AskSource[]
  /** 接管类：停下来的那些填表动作，补完后助理按它们从当前页接着填（apply_continue） */
  action_ids?: string[]
  /** 外部期限；null = 没有 */
  due_at: string | null
  /** 已经过了时间（只问考了没有） */
  overdue: boolean
  /** deadline 类：截止的种类（assessment / written_test / interview …） */
  deadline_kind?: string
  url?: string | null
  /** 来自哪封邮件 */
  source?: { inbox_item_id: string; received_at: string }
  /** info：缺的字段（明文只在本机，不进模型上下文） */
  fields?: AskField[]
  /** review：填后检查的数字 */
  review?: { required_filled: number | null; required_total: number | null; gaps: number }
  /** choice：网页弹窗问的话和它的按钮，卡上直接点选 */
  choice?: { question: string; options: string[] }
  /** review：这件是发邮件前过目（邮件投递）。卡上按动作 id 去专用接口取整封预览。 */
  mail?: AskMail
  /** failed：这件是邮件没写成 / 没发出去（卡上按钮据此变化）。 */
  mail_failed?: AskMailFailed
  /** 对话里接着办时发给助理的话（带对象 id） */
  suggest?: string
}

export interface AppCtx { company: CompanyMark; jobDeadline: string | null; label: string; role: string }
export type Ctx = { apps: Map<string, AppCtx>; nowIso: string; isTarget: (applicationId: string) => boolean }

const NAME_MAX = 6
export const shortName = (s: string) => (s.length > NAME_MAX ? s.slice(0, NAME_MAX) : s)
export const parseObj = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try { const v: unknown = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} } catch (e) {
    console.warn(`[career] asks: result_json 解析失败：${e instanceof Error ? e.message : String(e)}`); return {}
  }
}
export const records = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
export const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
export const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x))]

export function appContext(repos: Repos): Map<string, AppCtx> {
  const map = new Map<string, AppCtx>()
  for (const a of repos.applicationsWithJob()) {
    map.set(a.id, { company: companyMarkOf(a.job.company_name, a.job.company_id), jobDeadline: a.job.deadline, label: `${a.job.company_name ?? ''} ${a.job.title}`.trim(), role: a.job.title })
  }
  return map
}

export function companiesOf(ctx: Ctx, appIds: readonly string[]): CompanyMark[] {
  const seen = new Set<string>()
  const out: CompanyMark[] = []
  for (const id of appIds) {
    const c = ctx.apps.get(id)?.company
    if (c && !seen.has(c.name)) { seen.add(c.name); out.push(c) }
  }
  return out
}

/** 没有自己期限的事（缺信息、登录、待投）：挡住的申请里最早、还没过的网申截止就是它的外部期限。 */
export function earliestJobDeadline(ctx: Ctx, appIds: readonly string[]): string | null {
  const now = Date.parse(ctx.nowIso)
  let best: number | null = null
  for (const id of appIds) {
    const t = Date.parse(ctx.apps.get(id)?.jobDeadline ?? '')
    if (!Number.isNaN(t) && t > now && (best === null || t < best)) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}
