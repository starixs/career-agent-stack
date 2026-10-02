/**
 * 简历衍生物：投递邮件（主题 + 正文）与短平台投递语。
 */
import { extractJson, type LLM, type JdParsed } from '@career/core'
import type { Resume } from './schema.js'
import { jdKeywordList } from './jd.js'

export interface CoverEmailInput {
  resume: Resume
  jd: JdParsed
  /** 到岗时间 / 每周天数 / 可持续月数，如 "7 月初到岗，每周 4 天，可实习 6 个月"；缺省取 basics.availability */
  availability?: string
  /** 附件文件名；缺省按 `公司-岗位-姓名-学校.pdf` */
  attachmentName?: string
}
export interface CoverEmail { subject: string; body: string; attachment: string }

/** 主题规范：公司-岗位-姓名-学校（缺项自动跳过）。 */
export function emailSubject(resume: Resume, jd: JdParsed): string {
  const school = resume.education[0]?.school ?? ''
  const title = jd.title || resume.basics.objective
  return [jd.company, title, resume.basics.name, school].map(s => (s ?? '').trim()).filter(Boolean).join('-')
}

export const COVER_EMAIL_SYSTEM_PROMPT = `你是中国求职场景的投递邮件撰写助手。根据简历与 JD 写一封中文投递邮件正文，只输出严格 JSON：{ "body": "..." }。

要求：
- 正文三段，总长不超过 200 字（不含署名）：
  1. 我是谁 + 投什么岗（1-2 句）
  2. 三个匹配点（对齐 JD 硬性要求与关键词，每点一句，用短横线列表；只能用简历里出现过的事实与数字，不得新增）
  3. 到岗时间 + 附件说明 + 礼貌收尾
- 署名另起：姓名 / 学校 / 电话
- 语气克制，不用"赋能、打造、深耕、无缝衔接"等虚词，不用破折号
- 简历里没有的事实、数字、工具一律不写`

export async function coverEmail(llm: LLM, input: CoverEmailInput): Promise<CoverEmail> {
  const { resume, jd } = input
  const subject = emailSubject(resume, jd)
  const attachment = input.attachmentName ?? `${subject || resume.basics.name || '简历'}.pdf`
  const availability = input.availability ?? resume.basics.availability
  const user = [
    `【岗位】${jd.company ?? ''} ${jd.title ?? ''}`.trim(),
    `【硬性门槛】\n${jd.hard_requirements.map(s => '- ' + s).join('\n') || '（无）'}`,
    `【关键词】${jdKeywordList(jd).join('、') || '（无）'}`,
    `【到岗信息】${availability || '（未提供，正文里写"可按贵司安排尽快到岗"）'}`,
    `【附件】${attachment}`,
    `【简历 JSON】\n${JSON.stringify(resume, null, 1)}`,
  ].join('\n\n')
  const res = await llm.complete({ system: COVER_EMAIL_SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], json: true, temperature: 0.3 })
  const raw = extractJson<{ body?: string; subject?: string }>(res.text)
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  if (!body) throw new Error('邮件正文生成失败：模型没有返回 body')
  return { subject, body, attachment }
}

export interface ShortPitchInput { resume: Resume; jd: JdParsed; maxChars?: number; availability?: string }

export const SHORT_PITCH_SYSTEM_PROMPT = `你是中国求职场景的平台私信 / 微信投递语撰写助手。只输出严格 JSON：{ "pitch": "..." }。

要求：
- 不写邮件格式（没有称呼段落、没有署名块），一段话
- 最重要的信息放最前面：应聘岗位 → 最强的 1-2 个匹配点（带数字优先）→ 到岗信息 → 简历附件提示
- 只能用简历里出现过的事实与数字；不得编造
- 不超过给定字数上限；不用虚词、不用破折号`

export async function shortPitch(llm: LLM, input: ShortPitchInput): Promise<string> {
  const maxChars = input.maxChars ?? 120
  const { resume, jd } = input
  const availability = input.availability ?? resume.basics.availability
  const user = [
    `【字数上限】${maxChars} 字`,
    `【岗位】${jd.company ?? ''} ${jd.title ?? ''}`.trim(),
    `【关键词】${jdKeywordList(jd).join('、') || '（无）'}`,
    `【到岗信息】${availability || '（未提供则不写）'}`,
    `【简历 JSON】\n${JSON.stringify(resume, null, 1)}`,
  ].join('\n\n')
  const res = await llm.complete({ system: SHORT_PITCH_SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], json: true, temperature: 0.3 })
  const raw = extractJson<{ pitch?: string }>(res.text)
  const pitch = typeof raw.pitch === 'string' ? raw.pitch.replace(/\s+/g, ' ').trim() : ''
  if (!pitch) throw new Error('投递语生成失败：模型没有返回 pitch')
  return clampChars(pitch, maxChars)
}

/** 超长时在上限前最近的标点处截断。 */
export function clampChars(s: string, max: number): string {
  const chars = [...s]
  if (chars.length <= max) return s
  const head = chars.slice(0, max).join('')
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('！'))
  return (cut >= max * 0.5 ? head.slice(0, cut) : head).replace(/[，；]$/, '') + '。'
}
