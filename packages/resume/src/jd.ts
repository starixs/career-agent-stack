/**
 * JD 解析：九类分析 + Top 关键词三分类（已覆盖 / 可挖 / 真缺失）。
 * 结果结构兼容 @career/core 的 JdParsed，并附加 analysis 字段（可整体存进 job.jd_parsed_json）。
 */
import { extractJson, type LLM, type JdParsed } from '@career/core'
import { z } from 'zod'

export interface JdAnalysis {
  /** JD 要求的简历文件命名格式（原文），没有则空。 */
  file_naming: string
  /** 职能族，如 "行业研究" / "数据分析" / "产品"。 */
  function_family: string
  industry: string
  /** 券商/买方/银行/互联网/国央企/外企/创业公司 */
  company_type: string
  /** 材料最终给谁看：HR / 研究员 / 业务负责人 / 产品负责人 */
  audience: string
  hard_skills: string[]
  action_verbs: string[]
  domain_terms: string[]
  /** 标"优先/加分"的条目与文化用语 */
  style_signals: string[]
  /** 按频次与位置排好的 Top 10 关键词 */
  top_keywords: string[]
  /** 硬性门槛逐条比对里不满足的项（有候选人材料时才可能非空） */
  risks: string[]
}

export type JdParsedFull = JdParsed & { analysis: JdAnalysis }

export interface ParseJdOptions {
  /** 候选人材料（简历文本 + 已确认主张）。没有时关键词全部归入 missing 并在 notes 说明。 */
  candidate?: string
  /** 已知的公司名 / 岗位名（平台抓取到的），帮助模型消歧。 */
  company?: string
  title?: string
}

const strArr = z.array(z.union([z.string(), z.number()])).default([]).transform(a => a.map(String).map(s => s.trim()).filter(Boolean))
const optStr = z.union([z.string(), z.null(), z.undefined()]).transform(v => (v ?? '').toString().trim())

const JdOutSchema = z.object({
  company: optStr, title: optStr, degree: optStr, cohort: optStr, deadline: optStr,
  location: z.union([z.string(), z.array(z.string()), z.null(), z.undefined()]).transform(v => Array.isArray(v) ? v : v ? [v] : []),
  hard_requirements: strArr, responsibilities: strArr, nice_to_have: strArr, notes: strArr,
  keywords: z.object({ covered: strArr, diggable: strArr, missing: strArr }).default({}),
  analysis: z.object({
    file_naming: optStr, function_family: optStr, industry: optStr, company_type: optStr, audience: optStr,
    hard_skills: strArr, action_verbs: strArr, domain_terms: strArr, style_signals: strArr, top_keywords: strArr, risks: strArr,
  }).default({}),
})

export const JD_SYSTEM_PROMPT = `你是中国求职场景的 JD 分析助手。拿到岗位描述后按"九类信息"提取，输出严格 JSON（不要任何解释文字）。

九类信息：
1. 硬性门槛：学历 / 专业 / 年级 / 证书 / 每周天数与持续时长 / 必备工具，逐条列出
2. 文件命名要求：JD 明确要求的简历文件命名格式（原文），没有填空字符串
3. 职能关键词：岗位名及变体，判断职能族
4. 目标行业：业务所处行业、产业链位置、研究对象与核心指标（不要只写公司名）
5. 公司性质与读者：券商/买方/银行/互联网/国央企/外企/创业公司；材料给 HR、研究员、业务负责人还是产品负责人看
6. 硬技能：工具、软件、方法名（能被机器精确匹配的词）
7. 动作动词：职责描述里反复出现的动词
8. 领域术语：行业黑话与业务语境词
9. 加分项与风格信号：标"优先/加分"的条目，企业文化用语

规则：
- 软技能词（沟通、团队合作、抗压、学习能力）不算关键词，不提取。
- 按出现频次和位置（标题 > 职责首条 > 任职要求）排 Top 10 关键词，放 analysis.top_keywords。
- 关键词三分类：covered = 候选人材料能直接证明的；diggable = 候选人做过但没写出来或表达不到位的；missing = 候选人没做过的。三类合起来应覆盖 Top 10。
- 没有提供候选人材料时：covered 与 diggable 留空，全部放 missing，并在 notes 里写"未提供候选人材料，关键词未做三分类"。
- 硬性门槛与候选人材料逐条比对，不满足的写进 analysis.risks；没有材料则 risks 留空。
- 缺的信息填空字符串或空数组，不要编造公司名、截止日期。

输出格式：
{
  "company": "", "title": "", "location": [], "degree": "", "cohort": "", "deadline": "",
  "hard_requirements": [], "responsibilities": [], "nice_to_have": [], "notes": [],
  "keywords": { "covered": [], "diggable": [], "missing": [] },
  "analysis": { "file_naming": "", "function_family": "", "industry": "", "company_type": "", "audience": "",
    "hard_skills": [], "action_verbs": [], "domain_terms": [], "style_signals": [], "top_keywords": [], "risks": [] }
}`

export async function parseJd(llm: LLM, jdRaw: string, opts: ParseJdOptions = {}): Promise<JdParsedFull> {
  if (!jdRaw.trim()) throw new Error('JD 原文为空')
  const user = [
    opts.company || opts.title ? `已知信息：公司=${opts.company ?? '未知'}，岗位=${opts.title ?? '未知'}` : '',
    `【岗位描述】\n${jdRaw.trim()}`,
    opts.candidate ? `【候选人材料】\n${opts.candidate.trim()}` : '【候选人材料】\n（未提供）',
  ].filter(Boolean).join('\n\n')
  const res = await llm.complete({ system: JD_SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], json: true, temperature: 0 })
  const raw = extractJson<unknown>(res.text)
  const parsed = JdOutSchema.safeParse(raw)
  if (!parsed.success) throw new Error('JD 解析结果不合法：' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('；'))
  const d = parsed.data
  const out: JdParsedFull = {
    hard_requirements: d.hard_requirements, responsibilities: d.responsibilities, nice_to_have: d.nice_to_have,
    keywords: { covered: uniq(d.keywords.covered), diggable: uniq(d.keywords.diggable), missing: uniq(d.keywords.missing) },
    analysis: { ...d.analysis, top_keywords: uniq(d.analysis.top_keywords) },
  }
  if (d.company) out.company = d.company
  if (d.title) out.title = d.title
  if (d.location.length) out.location = d.location
  if (d.degree) out.degree = d.degree
  if (d.cohort) out.cohort = d.cohort
  if (d.deadline) out.deadline = d.deadline
  if (d.notes.length) out.notes = d.notes
  if (!opts.candidate) {
    // 没有候选人材料时强制三分类退化，避免模型"猜"覆盖情况。
    out.keywords = { covered: [], diggable: [], missing: uniq([...out.keywords.covered, ...out.keywords.diggable, ...out.keywords.missing]) }
    out.notes = uniq([...(out.notes ?? []), '未提供候选人材料，关键词未做三分类'])
    out.analysis.risks = []
  }
  return out
}

/** JD 的全部关键词（去重），供启发式打分用。 */
export function jdKeywordList(jd: JdParsed): string[] {
  const a = (jd as Partial<JdParsedFull>).analysis
  return uniq([...jd.keywords.covered, ...jd.keywords.diggable, ...jd.keywords.missing, ...(a?.top_keywords ?? []), ...(a?.hard_skills ?? []), ...(a?.domain_terms ?? [])])
}

function uniq(a: string[]): string[] { return [...new Set(a.map(s => s.trim()).filter(Boolean))] }
