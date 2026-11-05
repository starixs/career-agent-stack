/**
 * 投递通道（邮件投递，face-mail-apply 2026-11-05）：一个岗位走网申还是发邮件，投递邮箱从 JD 原文里怎么认。
 *
 * 结构先走、模型兜底：这里是规则抽取（纯函数，入库与批量投前懒补都用它）；JD 解析技能（jd-parse）输出的
 * apply_email 是兜底，当前为空时才写进去。认不准的宁可不认：认错一个邮箱 = 把简历发给客服。
 */
import type { Job } from './types.js'

/** 邮箱前后多远之内出现投递说法才算（约一句话）。 */
const CONTEXT_CHARS = 40
/** evidence 最多多长（给日志和测试看，不是给模型）。 */
const EVIDENCE_MAX = 60
/** evidence 里邮箱前后各留多少字。 */
const EVIDENCE_SIDE = 20

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** 投递语境：中文说法 + 英文词（英文按词边界，免得 apply 命中 apple）。 */
const APPLY_RX = /投递|简历|发送至|发至|发到|邮件申请|应聘|请将|\b(?:send|resume|cv|apply)\b/i
/** 明显不是投递的语境：只看邮箱前面那一段（紧挨着它的说法），后面的话常属于下一个邮箱。 */
const NOT_APPLY_RX = /投诉|举报|客服|商务合作|媒体/
const NO_REPLY_RX = /^no-?reply@/i

export interface ApplyEmailHit { email: string; evidence: string }

interface Found { email: string; start: number; end: number }

function allEmails(text: string): Found[] {
  return [...text.matchAll(EMAIL_RX)].map(m => ({ email: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
}

/** 邮箱前面那一段：最多 CONTEXT_CHARS 字，不越过上一个邮箱、不越过空行（段落）。 */
function beforeOf(text: string, found: readonly Found[], i: number): string {
  const floor = Math.max(i > 0 ? found[i - 1].end : 0, found[i].start - CONTEXT_CHARS)
  const seg = text.slice(floor, found[i].start)
  const para = seg.lastIndexOf('\n\n')
  return para >= 0 ? seg.slice(para + 2) : seg
}

/** 邮箱后面那一段：最多 CONTEXT_CHARS 字，不越过下一个邮箱。 */
function afterOf(text: string, found: readonly Found[], i: number): string {
  const ceil = Math.min(i + 1 < found.length ? found[i + 1].start : text.length, found[i].end + CONTEXT_CHARS)
  return text.slice(found[i].end, ceil)
}

function evidenceOf(before: string, email: string, after: string): string {
  const raw = `${before.slice(-EVIDENCE_SIDE)}${email}${after.slice(0, EVIDENCE_SIDE)}`.replace(/\s+/g, ' ').trim()
  return raw.slice(0, EVIDENCE_MAX)
}

/** JD 原文里的投递邮箱：只认投递语境里的、排除投诉 / 客服 / 合作等与 noreply；多个命中取第一个。没有返回 null。 */
export function extractApplyEmail(text: string): ApplyEmailHit | null {
  if (!text || !text.includes('@')) return null
  const found = allEmails(text)
  for (let i = 0; i < found.length; i++) {
    const { email } = found[i]
    if (NO_REPLY_RX.test(email)) continue
    const before = beforeOf(text, found, i)
    const after = afterOf(text, found, i)
    if (NOT_APPLY_RX.test(before)) continue
    if (!APPLY_RX.test(before) && !APPLY_RX.test(after)) continue
    return { email, evidence: evidenceOf(before, email, after) }
  }
  return null
}

export interface MailFormat { subject_format?: string; attachment_format?: string }

/** 「邮件标题 / 主题格式：…」 */
const SUBJECT_FORMAT_RX = /(?:邮件标题|邮件主题|标题格式|主题格式)(?:格式)?(?:请)?(?:注明|命名为|统一为|格式为|写为|写成|为)?\s*[:：]?\s*[“"「『]?([^。；;\n“”"」』，,]{2,60})/
/** 「附件 / 简历命名：…」 */
const ATTACHMENT_FORMAT_RX = /(?:附件|简历)(?:文件)?(?:请)?(?:统一)?(?:命名格式|命名为|命名|名称格式|名称)(?:为|格式)?\s*[:：]?\s*[“"「『]?([^。；;\n“”"」』，,]{2,60})/

const cleanFormat = (v: string | undefined): string | undefined => {
  const t = v?.trim().replace(/[\s.。]+$/, '')
  return t && t.length >= 2 ? t : undefined
}

/** 尽力抽 JD 指定的邮件标题格式与附件命名格式（原话）；抽不到就不给，不猜。 */
export function extractMailFormat(text: string): MailFormat {
  if (!text) return {}
  const subject = cleanFormat(SUBJECT_FORMAT_RX.exec(text)?.[1])
  const attachment = cleanFormat(ATTACHMENT_FORMAT_RX.exec(text)?.[1])
  return { ...(subject ? { subject_format: subject } : {}), ...(attachment ? { attachment_format: attachment } : {}) }
}

export type ApplyChannel = 'mail' | 'web'

/** 走哪条通道：JD 写明发邮箱就走邮件（面页等你定 1）；否则有网申链接走网申；都没有为 null（没写怎么投）。 */
export function applyChannelOf(job: Pick<Job, 'url' | 'apply_email'>): ApplyChannel | null {
  if (job.apply_email?.trim()) return 'mail'
  if (job.url?.trim()) return 'web'
  return null
}

/** 合法邮箱（收件人校验用；只认一个地址）。 */
export function isEmailAddress(v: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v.trim())
}

/** 收件域名（工具结果里只给这个，不给全址）。 */
export function emailDomain(v: string): string {
  const at = v.lastIndexOf('@')
  return at >= 0 ? v.slice(at + 1).trim().toLowerCase() : ''
}
