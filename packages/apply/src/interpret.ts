import { extractJson, type LLM } from '@career/core'
import type { FormField } from './extract.js'
import type { SiteAdapter } from './adapters/types.js'
import { normKey } from './text.js'
import { matchOption, normalizeValueForField } from './normalize.js'

/**
 * 把表单字段解释成填写计划：
 *  - 基本信息（姓名/邮箱/手机/学校…）直接从 profile.basics 填；
 *  - 高影响问题（薪资/签证/竞业/身份证…）只用 answer_bank 原话，没有就 needs_user；
 *  - 开放题（为什么/自我评价/经历描述…）用 LLM 起草，标 draft_needs_confirm，确认后才会填；
 *  - 每项带 source（profile|answer_bank|draft|none）与 confidence。
 * 不编造：profile 里没有的信息一律 needs_user，不猜。
 */

export interface ProfileExperience { title: string; org?: string; role?: string; period?: string; claims: string[] }
export interface ProfileEducation { school: string; major?: string; degree?: string; start?: string; end?: string }
export interface AnswerBankEntry { question_key: string; question_text?: string; answer: string; high_impact: boolean; confirmed?: boolean; /** 用户固定（总是用这条） */ pinned?: boolean }
export interface Profile {
  /** 键：name/email/phone/gender/birthday/school/major/degree/graduation/city/wechat/politics/hometown/availableDate/linkedin/github/portfolio/idNumber … */
  basics: Record<string, string | undefined>
  experiences: ProfileExperience[]
  /** 教育经历（多段；缺省由 basics 的学校 / 专业 / 学历拼成一段）。重复分区"教育经历"按它逐行填。 */
  education?: ProfileEducation[]
  answerBank: AnswerBankEntry[]
  /** 简历文件路径（有则自动上传）。 */
  resumePath?: string
}

export type PlanStatus = 'fill' | 'needs_user' | 'draft_needs_confirm' | 'skip'
export type PlanSource = 'profile' | 'answer_bank' | 'draft' | 'none'
export interface FieldPlan {
  fieldId: string
  label: string
  status: PlanStatus
  source: PlanSource
  confidence: number
  value?: string
  /** 资料键（profile 来源时有，如 phone / school）；站点记忆据此记录"该字段 ↔ 该键"。 */
  key?: string
  note?: string
  /** 草稿用到了哪些经历（先告知用户再复用）。 */
  experiencesUsed?: string[]
}

export interface InterpretOptions {
  adapter?: SiteAdapter
  /** 本次投递选用的经历（2–4 段）；缺省取前 4 段。 */
  selectedExperiences?: ProfileExperience[]
  /** 岗位上下文，帮助起草开放题。 */
  job?: { title?: string; company?: string; jd?: string }
  /** 已确认的草稿（label → 文本）：命中则直接 fill（source=draft, 已确认）。 */
  confirmedDrafts?: Record<string, string>
  /** 站点记忆：别名匹配不到时按字段签名（name / xpath / 标签）回忆上次填的资料键。 */
  recallKey?: (field: FormField) => string | undefined
}

/** 通用字段别名（label 包含别名即命中；长别名优先）。 */
export const BASIC_ALIASES: Record<string, string[]> = {
  name: ['真实姓名', '中文姓名', '姓名', '名字', 'full name', 'your name', 'name'],
  email: ['电子邮箱', '电子邮件', '邮箱', 'e-mail', 'email'],
  phone: ['手机号码', '手机号', '联系电话', '联系方式', '手机', '电话', 'mobile', 'phone', 'tel'],
  wechat: ['微信号', '微信', 'wechat'],
  gender: ['性别', 'gender'],
  birthday: ['出生日期', '出生年月', '生日', 'birth'],
  school: ['毕业院校', '毕业学校', '学校名称', '院校', '学校', 'university', 'college', 'school'],
  major: ['所学专业', '专业名称', '专业', 'major'],
  degree: ['最高学历', '学历', '学位', 'degree', 'education level'],
  graduation: ['毕业时间', '毕业年月', '毕业年份', '毕业日期', 'graduation'],
  city: ['期望工作城市', '期望城市', '意向城市', '工作城市', '所在城市', '现居城市', '现居地', '工作地点', '城市', 'location', 'city'],
  politics: ['政治面貌'],
  ethnicity: ['民族'],
  hometown: ['籍贯', '户籍', '户口所在地', '户口'],
  availableDate: ['到岗时间', '可入职时间', '可到岗时间', '入职时间', 'start date', 'available'],
  englishLevel: ['英语水平', '外语水平', '英语等级'],
  linkedin: ['领英', 'linkedin'],
  github: ['github'],
  portfolio: ['作品集', '个人网站', 'portfolio', 'website'],
  idNumber: ['身份证号码', '身份证号', '证件号码', '证件号', '身份证'],
}

/** 高影响问题：只能用答案库原话，不能猜。 */
export const HIGH_IMPACT_RX = /(薪资|薪酬|期望薪|待遇|年薪|月薪|salary|compensation|签证|visa|工作许可|work authori[sz]ation|sponsorship|竞业|违约金|服从调剂|是否接受(调剂|外派|出差|加班|轮岗|异地)|接受.*(出差|加班|轮岗)|身份证|证件号|护照|是否在职|离职原因|在职状态|offer)/i
/** 开放题：起草后要用户确认。 */
export const OPEN_QUESTION_RX = /(为什么|为何|请描述|请简述|请介绍|请说明|请谈谈|请举例|自我评价|自我介绍|个人优势|个人简介|职业规划|求职动机|申请理由|应聘理由|动机|经历描述|项目描述|实习经历|项目经历|获奖|荣誉|自荐|cover letter|why |describe|tell us|motivation)/i

export { normKey } from './text.js'

function matchBasic(label: string, aliases: Record<string, string[]>): string | null {
  const l = normKey(label)
  if (!l) return null
  let best: { key: string; len: number } | null = null
  for (const [key, list] of Object.entries(aliases)) for (const a of list) {
    const na = normKey(a)
    if (na && l.includes(na) && (!best || na.length > best.len)) best = { key, len: na.length }
  }
  return best?.key ?? null
}

/** 答案库匹配：question_key / question_text 与 label 互相包含即命中；confirmed 与更长的 key 优先。 */
export function findBankAnswer(label: string, bank: AnswerBankEntry[]): AnswerBankEntry | null {
  const l = normKey(label)
  if (!l) return null
  const hits = bank.filter(e => {
    const k = normKey(e.question_key); const t = normKey(e.question_text ?? '')
    return (k && (l === k || l.includes(k) || k.includes(l))) || (t && (l === t || l.includes(t) || t.includes(l)))
  })
  if (!hits.length) return null
  hits.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(!!b.confirmed) - Number(!!a.confirmed) || normKey(b.question_key).length - normKey(a.question_key).length)
  return hits[0]
}

/** 选项匹配：字典归一（学历 / 性别 / 政治面貌）+ 月份名 + 包含 + 模糊相等（见 normalize.ts）。 */
function pickOption(options: string[], value: string | undefined, hint: { key?: string; label?: string } = {}): string | undefined {
  return matchOption(options, value, hint)
}
/** 资料值按字段整形：字典归一、日期按 placeholder / type 推断格式。 */
function shapeValue(value: string, f: FormField, key?: string): string {
  return normalizeValueForField(value, { key, label: f.label, placeholder: f.placeholder, type: f.type, options: f.options, sample: f.value })
}

export async function interpretForm(llm: LLM, fields: FormField[], profile: Profile, opts: InterpretOptions = {}): Promise<FieldPlan[]> {
  const aliases: Record<string, string[]> = { ...BASIC_ALIASES }
  for (const [k, list] of Object.entries(opts.adapter?.hints.fieldAliases ?? {})) aliases[k] = [...list, ...(aliases[k] ?? [])]
  const confirmed = opts.confirmedDrafts ?? {}
  const plans: FieldPlan[] = []
  const toDraft: FormField[] = []

  for (const f of fields) {
    const label = f.label || f.name || ''
    const base = { fieldId: f.id, label }
    const highImpact = HIGH_IMPACT_RX.test(label)
    const isOpen = f.isRichText || f.type === 'textarea' || OPEN_QUESTION_RX.test(label)

    // 文件：有简历就上传
    if (f.isFile) {
      if (profile.resumePath && /简历|resume|cv|附件|上传/i.test(label || '简历')) plans.push({ ...base, status: 'fill', source: 'profile', confidence: 0.9, value: profile.resumePath })
      else plans.push({ ...base, status: 'needs_user', source: 'none', confidence: 0, note: profile.resumePath ? '不确定该上传什么文件' : '没有简历文件路径' })
      continue
    }
    // 已确认草稿
    const ck = Object.keys(confirmed).find(k => normKey(k) === normKey(label))
    if (ck) { plans.push({ ...base, status: 'fill', source: 'draft', confidence: 0.85, value: confirmed[ck], note: '用户已确认的草稿' }); continue }

    // 高影响：只用答案库原话
    if (highImpact) {
      const a = findBankAnswer(label, profile.answerBank)
      if (a) {
        const v = f.options.length ? pickOption(f.options, a.answer) : a.answer
        if (v) plans.push({ ...base, status: 'fill', source: 'answer_bank', confidence: a.confirmed ? 0.95 : 0.8, value: v, note: '高影响问题，使用答案库原话' })
        else plans.push({ ...base, status: 'needs_user', source: 'answer_bank', confidence: 0.3, note: `答案库答案「${a.answer}」不在选项里：${f.options.join(' / ')}` })
      } else plans.push({ ...base, status: 'needs_user', source: 'none', confidence: 0, note: '高影响问题，答案库里没有原话，不猜' })
      continue
    }
    // 答案库（非高影响也优先用原话）
    const bank = findBankAnswer(label, profile.answerBank)
    if (bank) {
      const v = f.options.length ? pickOption(f.options, bank.answer) : bank.answer
      if (v) { plans.push({ ...base, status: 'fill', source: 'answer_bank', confidence: bank.confirmed ? 0.9 : 0.75, value: v }); continue }
    }
    // 基本信息：别名匹配 → 站点记忆（上次在这站这个字段填的是哪个键）
    let key = matchBasic(label, aliases)
    let viaMemory = false
    if (!key && opts.recallKey) { const k = opts.recallKey(f); if (k && profile.basics[k] !== undefined) { key = k; viaMemory = true } }
    const basicValue = key ? profile.basics[key] : undefined
    if (key && basicValue) {
      if (f.type === 'checkbox') { plans.push({ ...base, status: 'skip', source: 'none', confidence: 0, note: '复选框不自动勾选' }); continue }
      const memoryNote = viaMemory ? '按站点记忆匹配' : undefined
      if (f.options.length) {
        const v = pickOption(f.options, basicValue, { key, label })
        if (v) plans.push({ ...base, status: 'fill', source: 'profile', confidence: viaMemory ? 0.75 : 0.85, value: v, key, note: memoryNote })
        else plans.push({ ...base, status: f.required ? 'needs_user' : 'skip', source: 'profile', confidence: 0.3, key, note: `资料值「${basicValue}」匹配不到选项` })
      } else {
        const shaped = shapeValue(basicValue, f, key)
        plans.push({ ...base, status: 'fill', source: 'profile', confidence: viaMemory ? 0.8 : 0.9, value: f.maxLength ? shaped.slice(0, f.maxLength) : shaped, key, note: memoryNote })
      }
      continue
    }
    if (key && !basicValue) { plans.push({ ...base, status: f.required ? 'needs_user' : 'skip', source: 'none', confidence: 0, key, note: `资料里缺少 ${key}` }); continue }

    // 开放题 → 起草
    if (isOpen && f.type !== 'checkbox' && !f.options.length) { toDraft.push(f); continue }
    // 其余：选择题 / 复选框 / 未知短文本
    if (f.type === 'checkbox') { plans.push({ ...base, status: 'skip', source: 'none', confidence: 0, note: '复选框需用户自行勾选' }); continue }
    plans.push({ ...base, status: f.required ? 'needs_user' : 'skip', source: 'none', confidence: 0, note: '无法从资料确定' })
  }

  if (toDraft.length) plans.push(...await draftOpenQuestions(llm, toDraft, profile, opts))
  const order = new Map(fields.map((f, i) => [f.id, i]))
  return plans.sort((a, b) => (order.get(a.fieldId) ?? 0) - (order.get(b.fieldId) ?? 0))
}

async function draftOpenQuestions(llm: LLM, fields: FormField[], profile: Profile, opts: InterpretOptions): Promise<FieldPlan[]> {
  const exps = (opts.selectedExperiences ?? profile.experiences).slice(0, 4)
  const system = `你是求职者本人的网申助手，为开放题起草答案。规则：
1. 只能用下面给出的经历与主张，不得编造任何经历、数据、头衔；信息不足就写短一点或留空。
2. 中文、第一人称、具体动作与结果，不写套话（赋能/闭环/抓手）。
3. 遵守 maxLength。
4. 需要写到姓名 / 手机 / 邮箱时用占位符 {{vault:profile.name}} / {{vault:profile.phone}} / {{vault:profile.email}}，不要猜具体值；经历里形如 {{vault:exp.xxx.yyy}} 的占位符原样保留。
5. 只输出 JSON：{"answers":[{"id":"f3","value":"...","confidence":0.7,"experiences_used":["经历标题"]}]}`
  // 只给模型非敏感的背景信息；姓名 / 联系方式等私密字段永远不进提示词（草稿里需要时写占位符 {{vault:profile.name}}）
  const user = JSON.stringify({
    job: opts.job ?? null,
    basics: { school: profile.basics.school, major: profile.basics.major, degree: profile.basics.degree, graduation: profile.basics.graduation },
    experiences: exps.map(e => ({ title: e.title, org: e.org, role: e.role, period: e.period, claims: e.claims })),
    questions: fields.map(f => ({ id: f.id, label: f.label, type: f.type, maxLength: f.maxLength, placeholder: f.placeholder })),
  })
  let answers: Array<{ id: string; value?: string; confidence?: number; experiences_used?: string[] }> = []
  let err: string | undefined
  try {
    const res = await llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.4 })
    const parsed = extractJson<{ answers?: typeof answers } | typeof answers>(res.text)
    answers = Array.isArray(parsed) ? parsed : parsed.answers ?? []
  } catch (e) { err = e instanceof Error ? e.message : String(e) }
  return fields.map(f => {
    const a = answers.find(x => x.id === f.id)
    const value = (a?.value ?? '').trim()
    if (!value) return { fieldId: f.id, label: f.label, status: 'needs_user' as const, source: 'none' as const, confidence: 0, note: err ? `起草失败：${err}` : '模型没有给出草稿' }
    return { fieldId: f.id, label: f.label, status: 'draft_needs_confirm' as const, source: 'draft' as const, confidence: Math.min(0.7, Number(a?.confidence ?? 0.5)), value: f.maxLength ? value.slice(0, f.maxLength) : value, experiencesUsed: a?.experiences_used ?? exps.map(e => e.title), note: '草稿，需确认后填写' }
  })
}
