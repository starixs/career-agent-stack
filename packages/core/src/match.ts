/**
 * 可解释的岗位匹配（确定性，不调模型）：回答"哪条要求，对应你哪段真实经历"，而不只是一个分数。
 *
 *  1. 硬条件（用户明确的条件，违反就不推荐）：届别、学历、城市、校招 / 实习类型、是否已过截止。
 *  2. 要求项：JD 解析的硬性要求 + 关键词；没有解析结果时按技能词表从 JD 原文抽。
 *     每一项到"证据"（已确认的经历主张、简历条目）里找同义词命中，给出 covered / missing 与对应证据。
 *  3. 分数：硬条件不过 → 最高 20；否则 40 + 60 × 覆盖率（硬性要求权重 2、关键词权重 1）。
 *
 * 技能同义词表是国内 JD 常见写法的起点（岗位别名、工具、方法）；不认识的词按原词包含匹配。
 */
import type { Job } from './types.js'
import { normalizeCohort, type EmploymentType, type JobPrefs } from './jobs.js'

export interface MatchEvidence { id: string; kind: 'claim' | 'resume'; text: string; label?: string }
export interface HardCheck { rule: 'cohort' | 'degree' | 'city' | 'employment_type' | 'deadline'; label: string; ok: boolean | null; detail: string }
export interface RequirementMatch { requirement: string; weight: number; status: 'covered' | 'missing'; terms: string[]; evidence?: { id: string; kind: MatchEvidence['kind']; text: string; label?: string } }
export interface JobMatch {
  score: number
  hard_ok: boolean
  hard: HardCheck[]
  requirements: RequirementMatch[]
  covered: number
  total: number
  summary: string
  computed_at: string
}

/** 技能 / 岗位同义词（规范名 → 写法）。 */
export const SKILL_LEXICON: Record<string, string[]> = {
  Python: ['python', 'py ', 'pandas', 'numpy'], Java: ['java', 'spring', 'springboot', 'jvm'], 'C/C++': ['c++', 'cpp', 'c语言'], Go: ['golang', 'go语言'],
  JavaScript: ['javascript', 'js', 'typescript', 'ts', 'node'], 前端: ['前端', 'react', 'vue', 'html', 'css', 'web开发'],
  SQL: ['sql', 'mysql', 'hive', 'postgresql', 'pgsql', 'clickhouse', 'presto', 'spark sql'], Excel: ['excel', 'vba', '数据透视', 'vlookup'],
  数据分析: ['数据分析', '分析报告', '数据洞察', '指标体系', 'bi', 'tableau', 'power bi', '可视化'], 'A/B 测试': ['a/b', 'ab测试', 'ab test', '实验设计'],
  机器学习: ['机器学习', 'machine learning', 'ml', 'xgboost', 'lightgbm', 'sklearn', '特征工程'], 深度学习: ['深度学习', 'pytorch', 'tensorflow', '神经网络', 'cnn', 'transformer'],
  大模型: ['大模型', 'llm', 'gpt', 'prompt', '提示词', 'rag', 'agent', 'aigc'], 自然语言处理: ['nlp', '自然语言处理', '文本分类', '命名实体'], 计算机视觉: ['cv', '计算机视觉', '图像识别', '目标检测'],
  推荐系统: ['推荐系统', '推荐算法', '召回', '排序模型', 'ctr'], 统计: ['统计', '回归分析', '假设检验', 'spss', 'stata', 'r语言'],
  Linux: ['linux', 'shell', 'bash'], 'Git': ['git', 'github', 'gitlab'], 分布式: ['分布式', '微服务', 'kafka', 'redis', '高并发'], 云计算: ['云计算', 'docker', 'kubernetes', 'k8s', 'aws', '阿里云'],
  产品设计: ['产品设计', '需求分析', 'prd', '原型', 'axure', '墨刀', '用户调研', '竞品分析'], 项目管理: ['项目管理', 'pmp', '推进', '跨部门协作', '排期'],
  用户运营: ['用户运营', '社群运营', '用户增长', '拉新', '留存', '私域'], 内容运营: ['内容运营', '新媒体', '公众号', '小红书', '抖音', '短视频', '文案'], 活动运营: ['活动运营', '活动策划'],
  市场营销: ['市场营销', '品牌', '营销', '投放', '广告', 'campaign'], 视觉设计: ['视觉设计', 'ui设计', 'figma', 'sketch', 'photoshop', 'ps', 'illustrator'], 交互设计: ['交互设计', 'ux', '用户体验'],
  财务: ['财务', '会计', 'cpa', 'acca', '审计', '报表', '财务分析'], 金融: ['金融', '投行', '行研', '估值', '建模', 'cfa', '债券', '股票'], 咨询: ['咨询', '案例分析', 'case'],
  法务: ['法务', '法律', '合同', '法考'], 人力资源: ['人力资源', '招聘', 'hr', '培训', '薪酬'], 销售: ['销售', '客户开发', 'bd', '商务拓展'],
  英语: ['英语', 'cet-6', 'cet6', '六级', '雅思', 'ielts', '托福', 'toefl', '英文'], 日语: ['日语', 'n1', 'n2'],
  沟通表达: ['沟通', '表达'], 测试: ['测试', 'qa', '自动化测试', 'selenium'], 嵌入式: ['嵌入式', '单片机', 'stm32', 'rtos'], 硬件: ['硬件', '电路', 'pcb', 'fpga'],
}

const DEGREE_RANK: Record<string, number> = { 大专: 1, 专科: 1, 本科: 2, 学士: 2, 硕士: 3, 研究生: 3, 博士: 4 }
function degreeRank(s: string | null | undefined): number | null {
  if (!s) return null
  let best: number | null = null
  for (const [k, v] of Object.entries(DEGREE_RANK)) if (s.includes(k)) best = best === null ? v : Math.min(best, v)
  return best
}

const lc = (s: string) => s.normalize('NFKC').toLowerCase()

/** 一段文字里出现了哪些规范技能。 */
export function skillsIn(text: string): string[] {
  const t = ` ${lc(text)} `
  return Object.entries(SKILL_LEXICON).filter(([name, forms]) => t.includes(lc(name)) || forms.some(f => t.includes(lc(f)))).map(([name]) => name)
}

/** 要求项 → 要匹配的规范技能；不在词表里就用原词。 */
function termsOf(requirement: string): string[] {
  const hits = skillsIn(requirement)
  if (hits.length) return hits
  const word = requirement.replace(/^(熟悉|熟练掌握|掌握|了解|精通|具备|有|具有)/, '').replace(/[，。；;,.].*$/, '').trim()
  return word && word.length <= 12 ? [word] : []
}

function evidenceFor(terms: string[], evidence: MatchEvidence[]): MatchEvidence | undefined {
  for (const term of terms) {
    const forms = SKILL_LEXICON[term] ? [term, ...SKILL_LEXICON[term]] : [term]
    const hit = evidence.find(e => { const t = ` ${lc(e.text)} `; return forms.some(f => t.includes(lc(f))) })
    if (hit) return hit
  }
  return undefined
}

export interface JobMatchInput {
  job: Pick<Job, 'title' | 'location' | 'jd_raw' | 'jd_parsed_json' | 'deadline'> & { employment_type?: string | null; cohort?: string | null }
  prefs: JobPrefs
  evidence: MatchEvidence[]
  today?: string
}

export function matchJob(input: JobMatchInput): JobMatch {
  const { job, prefs, evidence } = input
  const parsed = safeParse(job.jd_parsed_json)
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const hard: HardCheck[] = []
  // 届别
  const jobCohort = normalizeCohort(job.cohort ?? parsed.cohort ?? job.jd_raw ?? '')
  const myCohort = normalizeCohort(prefs.cohort ?? '')
  if (myCohort) hard.push(jobCohort ? { rule: 'cohort', label: '届别', ok: jobCohort === myCohort, detail: jobCohort === myCohort ? `招 ${jobCohort}，和你一致` : `招 ${jobCohort}，你是 ${myCohort}` } : { rule: 'cohort', label: '届别', ok: null, detail: 'JD 没写届别，投前核对' })
  // 学历
  const need = degreeRank(parsed.degree ?? extract(job.jd_raw, /(大专|专科|本科|硕士|研究生|博士)(及以上)?(学历)?/))
  const mine = degreeRank(prefs.degree ?? '')
  if (mine !== null) hard.push(need === null ? { rule: 'degree', label: '学历', ok: null, detail: 'JD 没写学历要求' } : { rule: 'degree', label: '学历', ok: mine >= need, detail: mine >= need ? '学历满足' : `要求${Object.keys(DEGREE_RANK).find(k => DEGREE_RANK[k] === need)}及以上` })
  // 城市
  if (prefs.cities?.length) {
    const locs = [job.location ?? '', ...(Array.isArray(parsed.location) ? parsed.location : [])].join('/')
    if (!locs.trim()) hard.push({ rule: 'city', label: '城市', ok: null, detail: 'JD 没写地点' })
    else { const hit = prefs.cities.find(c => locs.includes(c)); hard.push({ rule: 'city', label: '城市', ok: !!hit || /不限|全国|远程/.test(locs), detail: hit ? `${hit} 在工作地点里` : `工作地点：${locs}` }) }
  }
  // 类型
  if (prefs.employment_types?.length && job.employment_type && job.employment_type !== 'unknown') {
    const ok = prefs.employment_types.includes(job.employment_type as EmploymentType)
    hard.push({ rule: 'employment_type', label: '类型', ok, detail: ok ? '类型符合' : `这是${TYPE_LABEL[job.employment_type] ?? job.employment_type}` })
  }
  // 截止
  if (job.deadline) { const expired = job.deadline.slice(0, 10) < today; hard.push({ rule: 'deadline', label: '截止', ok: !expired, detail: expired ? `已于 ${job.deadline.slice(0, 10)} 截止` : `${job.deadline.slice(0, 10)} 截止` }) }

  // 要求项
  const reqs: Array<{ text: string; weight: number }> = []
  for (const r of (Array.isArray(parsed.hard_requirements) ? parsed.hard_requirements : []) as string[]) if (typeof r === 'string' && termsOf(r).length) reqs.push({ text: r, weight: 2 })
  const kw = parsed.keywords && typeof parsed.keywords === 'object' ? [...(parsed.keywords.covered ?? []), ...(parsed.keywords.diggable ?? []), ...(parsed.keywords.missing ?? [])] : []
  for (const k of kw as string[]) if (typeof k === 'string' && !reqs.some(r => r.text.includes(k))) reqs.push({ text: k, weight: 1 })
  if (!reqs.length) for (const s of skillsIn(`${job.title} ${job.jd_raw ?? ''}`)) reqs.push({ text: s, weight: 1 })
  const requirements: RequirementMatch[] = reqs.slice(0, 20).map(r => {
    const terms = termsOf(r.text)
    const ev = evidenceFor(terms, evidence)
    return { requirement: r.text, weight: r.weight, terms, status: ev ? 'covered' : 'missing', ...(ev ? { evidence: { id: ev.id, kind: ev.kind, text: ev.text.slice(0, 160), label: ev.label } } : {}) }
  })
  const total = requirements.reduce((n, r) => n + r.weight, 0)
  const got = requirements.filter(r => r.status === 'covered').reduce((n, r) => n + r.weight, 0)
  const hardOk = hard.every(h => h.ok !== false)
  const coverage = total ? got / total : 0
  const score = Math.round(hardOk ? 40 + 60 * coverage : Math.min(20, 20 * coverage))
  const failed = hard.filter(h => h.ok === false).map(h => `${h.label}：${h.detail}`)
  const coveredN = requirements.filter(r => r.status === 'covered').length
  const summary = failed.length ? `不符合你的条件（${failed.join('；')}）` : total ? `${requirements.length} 项要求里有 ${coveredN} 项能用你的经历证明` : 'JD 信息太少，没法逐项对照'
  return { score, hard_ok: hardOk, hard, requirements, covered: coveredN, total: requirements.length, summary, computed_at: new Date().toISOString() }
}

const TYPE_LABEL: Record<string, string> = { campus: '校招', intern: '实习', social: '社招' }

function safeParse(raw: string | null | undefined): { cohort?: string; degree?: string; location?: string[]; hard_requirements?: unknown[]; keywords?: { covered?: string[]; diggable?: string[]; missing?: string[] } } {
  try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
function extract(text: string | null | undefined, rx: RegExp): string | undefined { return text?.match(rx)?.[0] }
