/**
 * 场景事件（候选卖点）：按求职场景记「替用户做成了什么」，供以后按件 / 按套餐计价用。
 *
 * 现在只记数、不扣积分：定价没定，先把可能的卖点都埋上，定价后再精简（2026-11-05 用户定）。
 * 和 billing_usage（模型 token、搜索次数，按成本计）是两本账：这里按「成果」计，一件事只记一次（幂等键）。
 * 新增卖点：在 BILLABLE_EVENTS 加一行，再在发生处调 recordBusinessEvent。
 */
import { type Db, now } from '../db/db.js'
import { newId } from '../ids.js'

export interface BillableEventDef {
  label: string
  /** 计数单位：份 / 次 / 条 / 道 / 封 */
  unit: string
  /** 一句话：什么时候算一次 */
  when: string
}

export const BILLABLE_EVENTS = {
  application_sent: { label: '替你投出', unit: '份', when: '产品亲手完成提交：网申点了提交，或投递邮件发出' },
  form_filled: { label: '填好网申表', unit: '份', when: '一份网申表填完（等你过目或已提交）' },
  greeting_sent: { label: '发出招呼', unit: '条', when: '招聘平台上的打招呼发出' },
  resume_created: { label: '做好主简历', unit: '份', when: '导入或从零写好一份主简历' },
  resume_tailored: { label: '按岗位定制简历', unit: '份', when: '为一个岗位改出一版简历' },
  material_drafted: { label: '写好材料', unit: '份', when: '开放题答案、求职信等材料起草完成' },
  job_imported: { label: '导入岗位', unit: '个', when: '一个岗位进了岗位库' },
  job_evaluated: { label: '岗位匹配评估', unit: '个', when: '评估一个岗位和你合不合适' },
  company_researched: { label: '公司调研', unit: '家', when: '出一份公司调研报告' },
  career_planned: { label: '方向与差距规划', unit: '次', when: '方向探索或差距规划出结果' },
  interview_prepped: { label: '面试准备', unit: '次', when: '面试题预测、追问演练、项目故事等准备出结果' },
  interview_reviewed: { label: '面试复盘', unit: '场', when: '一场面试复盘完成' },
  exam_practiced: { label: '笔试练习', unit: '套', when: '一套笔试练习出题或批改' },
  exam_answered: { label: '笔试搜题', unit: '道', when: '一道题给出答案' },
  captcha_solved: { label: '过验证码', unit: '次', when: '验证码自动通过' },
  mail_triaged: { label: '邮件归档', unit: '封', when: '一封求职相关邮件被认出并归到对应申请' },
  mail_drafted: { label: '起草邮件', unit: '封', when: '一封邮件写好待发' },
  offer_compared: { label: 'Offer 对比', unit: '次', when: '多个 Offer 对比出结论' },
  recording_transcribed: { label: '面试录音转写', unit: '分钟', when: '面试录音转成文字（语音识别接上后）' },
} as const satisfies Record<string, BillableEventDef>

export type BillableEvent = keyof typeof BILLABLE_EVENTS

export function isBillableEvent(v: string): v is BillableEvent {
  return Object.hasOwn(BILLABLE_EVENTS, v)
}

export interface BusinessEventInput {
  event: BillableEvent
  /** 幂等键：同一件事重复上报只记一次（如 `action:<动作 id>`、`tool:<工具>:<调用 id>`） */
  key: string
  quantity?: number
  refType?: string | null
  refId?: string | null
  meta?: Record<string, unknown>
}

/** 记一件事；同键第二次返回 false。 */
export function recordBusinessEvent(db: Db, input: BusinessEventInput): boolean {
  const quantity = Math.max(Math.round(input.quantity ?? 1), 0)
  const r = db.run(`INSERT OR IGNORE INTO billing_event (id, idempotency_key, event, quantity, ref_type, ref_id, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [newId('evt'), input.key, input.event, quantity, input.refType ?? null, input.refId ?? null, JSON.stringify(input.meta ?? {}), now()])
  return r.changes > 0
}

export interface EventCount { event: BillableEvent; label: string; unit: string; count: number }

/** 某个时间以来每种事件的件数，按件数从多到少；没发生过的不出现。 */
export function countBusinessEvents(db: Db, sinceIso: string): EventCount[] {
  const rows = db.all<{ event: string; n: number }>('SELECT event, SUM(quantity) AS n FROM billing_event WHERE created_at >= ? GROUP BY event ORDER BY n DESC', [sinceIso])
  return rows.flatMap(r => (isBillableEvent(r.event) ? [{ event: r.event, label: BILLABLE_EVENTS[r.event].label, unit: BILLABLE_EVENTS[r.event].unit, count: r.n }] : []))
}

/** 动作队列里哪种动作做完算哪个卖点（Repos.setActionStatus 在动作变成 done 时调）。 */
export const ACTION_DONE_EVENTS: Readonly<Record<string, BillableEvent>> = {
  submit: 'application_sent',
  send_mail: 'application_sent',
  fill_form: 'form_filled',
  send_greeting: 'greeting_sent',
}
