/**
 * 简历定制流水线：三档强度（nudge / keywords / full）、JSON Patch 输出、每条改动附理由、编造检测。
 * 铁律：只能用经历库里 status 为 verified / user_confirmed 的主张；数字与专有名词必须在 master 或主张里出现过。
 */
import { extractJson, type LLM, type Claim, type JdParsed } from '@career/core'
import jsonpatch from 'fast-json-patch'
import type { Operation } from 'fast-json-patch'
import { ResumeSchema, listBullets, resumeText, orderedSections, type Resume, type BulletRef } from './schema.js'
import { jdKeywordList } from './jd.js'
import { wrapText, packSegments, CLASSIC_CN } from './render/measure.js'

const { applyPatch, getValueByPointer, deepClone } = jsonpatch

export type TailorStrength = 'nudge' | 'keywords' | 'full'

export interface TailorInput {
  master: Resume
  jd: JdParsed
  claims: Claim[]
  strength?: TailorStrength
  /** 为 true 时，被编造检测标记的改动直接丢弃（默认保留并标记，交给用户确认）。 */
  rejectFlagged?: boolean
}

export interface TruthFlag { path: string; kind: 'number' | 'term'; token: string; text: string; reason: string }
export interface TailorRationale { path: string; op: Operation['op']; reason: string; original?: unknown; value?: unknown; claim_ids: string[]; flags: TruthFlag[] }
export interface RejectedChange { path: string; reason: string; raw: unknown }

export interface TailorResult {
  proposed: Resume
  /** RFC 6902 JSON Patch，可用 fast-json-patch 应用到 master 得到 proposed。 */
  patch: Operation[]
  rationale: TailorRationale[]
  truthfulnessFlags: TruthFlag[]
  rejected: RejectedChange[]
  strategyNotes: string
  /** 实际参与定制的主张（已确认） / 被排除的待核实主张数 */
  usableClaims: Claim[]
  excludedClaims: number
}

const STRENGTH_RULES: Record<TailorStrength, string> = {
  nudge: '强度 nudge（轻推）：只允许 replace 改写已有 bullet 的措辞，让表述更贴近 JD 用词；不新增、不删除、不重排。改动尽量少。',
  keywords: '强度 keywords（关键词）：允许 replace（把 JD 关键词自然植入已有 bullet，一条 bullet 最多命中 1-2 个关键词）与 reorder（按相关度重排 bullet、技能关键词）；不新增、不删除 bullet。',
  full: '强度 full（深度定制）：允许 replace、reorder、add（基于事实清单里有但简历没写的主张新增 bullet，claim_ids 必须引用对应主张）、remove（删除与 JD 无关的 bullet）。仍然不能新增经历/项目条目，不能改日期、公司、学校、学历。',
}

export const TAILOR_SYSTEM_PROMPT = `你是中国求职场景的简历定制助手。你的任务是依据岗位 JD 对候选人简历做"有依据的改写"，并以改动清单（JSON Patch 风格）输出，而不是整份重写。

三条铁律：
1. 保真：每个字都要经得起面试追问三层。数字、工具名、公司名、项目名只能来自【简历原文】或【事实清单】；缺数据就不写，绝不推测补数。职责可以重新组织语言，不能升格（实习生 ≠ 负责人；协助 ≠ 主导）。
2. 价值翻译：每条 bullet = 动作 + 落地方式 + 量化结果，回答"我为什么对你有用"，不是工作日志。动词开头，不写"我"。
3. 关键词对齐 ≠ 堆砌：用 JD 反复出现的动词、名词重写候选人真做过的事；与 JD 强相关的内容靠前，弱相关压缩。

排雷：模糊量词（很多、大量、丰富、多次）与 AI 味虚词（赋能、打造、深耕、多维度、无缝衔接、抓手）不得出现；不用破折号。

可改路径（JSON Pointer）：
- /experience/{i}/bullets/{j}、/experience/{i}/roles/{k}/bullets/{j}
- /projects/{i}/bullets/{j}
- /education/{i}/bullets/{j}、/education/{i}/courses
- /custom_sections/{i}/items/{j}/bullets/{k}
- /skills（整体 reorder）、/skills/{i}/keywords（reorder 或单个 replace）
- /basics/objective（求职意向，可按 JD 岗位名改写）
不可改：姓名、联系方式、日期、公司名、学校、学历、专业、证书、奖项。

每条改动的格式：
{ "op": "replace" | "add" | "remove" | "reorder", "path": "...", "original": "原文（replace/remove 必填，逐字精确复制）", "value": "新值（add/replace/reorder 必填）", "claim_ids": ["引用的主张 id"], "reason": "这条改动为何有助于匹配 JD（一句话）" }
- reorder：path 指向数组，value 是重排后的完整数组，元素必须与原数组完全相同。
- add：path 指向 bullets 数组（追加到末尾），claim_ids 必须非空。

输出严格 JSON：{ "changes": [ ... ], "strategy_notes": "本次定制思路（两三句）" }。不要输出整份简历。`

export async function tailorResume(llm: LLM, input: TailorInput): Promise<TailorResult> {
  const strength = input.strength ?? 'keywords'
  const master = ResumeSchema.parse(input.master)
  const usableClaims = input.claims.filter(c => c.status === 'verified' || c.status === 'user_confirmed')
  const excludedClaims = input.claims.length - usableClaims.length
  const user = buildTailorUserPrompt(master, input.jd, usableClaims, strength)
  const res = await llm.complete({ system: TAILOR_SYSTEM_PROMPT + '\n\n' + STRENGTH_RULES[strength], messages: [{ role: 'user', content: user }], json: true, temperature: 0.2 })
  const raw = extractJson<{ changes?: unknown[]; strategy_notes?: string }>(res.text)
  const changes = Array.isArray(raw.changes) ? raw.changes : []
  return buildTailorResult(master, changes, { strength, usableClaims, excludedClaims, strategyNotes: typeof raw.strategy_notes === 'string' ? raw.strategy_notes : '', rejectFlagged: input.rejectFlagged ?? false })
}

export function buildTailorUserPrompt(master: Resume, jd: JdParsed, usableClaims: Claim[], strength: TailorStrength): string {
  const claimLines = usableClaims.length
    ? usableClaims.map(c => `- [${c.id}] ${c.text}${c.result_metric ? `（结果：${c.result_metric}）` : ''}（归属：${c.attribution === 'self' ? '本人' : c.attribution === 'team' ? '团队' : '未知'}）`).join('\n')
    : '（没有已确认的主张；只能改写简历原文的措辞，不得新增任何事实）'
  const kw = jd.keywords
  return [
    `【定制强度】${strength}`,
    `【岗位】${jd.company ?? ''} ${jd.title ?? ''}`.trim(),
    `【硬性门槛】\n${jd.hard_requirements.map(s => '- ' + s).join('\n') || '（无）'}`,
    `【岗位职责】\n${jd.responsibilities.map(s => '- ' + s).join('\n') || '（无）'}`,
    `【关键词】已覆盖：${kw.covered.join('、') || '无'}；可挖：${kw.diggable.join('、') || '无'}；真缺失（不得编造）：${kw.missing.join('、') || '无'}`,
    `【事实清单】（已确认主张，可引用其 id）\n${claimLines}`,
    `【简历原文 JSON】\n${JSON.stringify(master, null, 1)}`,
  ].join('\n\n')
}

// ---------- 改动校验与应用 ----------

const PATH_RULES: Array<{ re: RegExp; kind: 'string' | 'array' | 'element' }> = [
  { re: /^\/(experience\/\d+(\/roles\/\d+)?|projects\/\d+|education\/\d+|custom_sections\/\d+\/items\/\d+)\/bullets\/\d+$/, kind: 'element' },
  { re: /^\/(experience\/\d+(\/roles\/\d+)?|projects\/\d+|education\/\d+|custom_sections\/\d+\/items\/\d+)\/bullets$/, kind: 'array' },
  { re: /^\/education\/\d+\/courses(\/\d+)?$/, kind: 'array' },
  { re: /^\/skills$/, kind: 'array' },
  { re: /^\/skills\/\d+\/keywords$/, kind: 'array' },
  { re: /^\/skills\/\d+\/keywords\/\d+$/, kind: 'element' },
  { re: /^\/basics\/objective$/, kind: 'string' },
]
const ALLOWED_OPS: Record<TailorStrength, Set<string>> = {
  nudge: new Set(['replace']),
  keywords: new Set(['replace', 'reorder']),
  full: new Set(['replace', 'reorder', 'add', 'remove']),
}

interface RawChange { op?: string; path?: string; original?: unknown; value?: unknown; claim_ids?: unknown; reason?: unknown }

export function buildTailorResult(master: Resume, changes: unknown[], ctx: { strength: TailorStrength; usableClaims: Claim[]; excludedClaims: number; strategyNotes: string; rejectFlagged: boolean }): TailorResult {
  const claimIdSet = new Set(ctx.usableClaims.map(c => c.id))
  const corpus = buildCorpus(master, ctx.usableClaims)
  const rejected: RejectedChange[] = []
  let working: Resume = deepClone(master)
  const patch: Operation[] = []
  const rationale: TailorRationale[] = []

  for (const rawItem of changes) {
    const c = (rawItem ?? {}) as RawChange
    const path = typeof c.path === 'string' ? c.path.trim() : ''
    const op = typeof c.op === 'string' ? c.op : ''
    const reject = (reason: string) => rejected.push({ path, reason, raw: rawItem })
    if (!path || !op) { reject('缺少 op 或 path'); continue }
    if (!ALLOWED_OPS[ctx.strength].has(op)) { reject(`强度 ${ctx.strength} 不允许 ${op}`); continue }
    const rule = PATH_RULES.find(r => r.re.test(path))
    if (!rule) { reject('路径不在允许范围内'); continue }
    const claim_ids = Array.isArray(c.claim_ids) ? c.claim_ids.filter((x): x is string => typeof x === 'string') : []
    const reason = typeof c.reason === 'string' ? c.reason : ''
    let current: unknown
    try { current = getValueByPointer(working, path) } catch { current = undefined }

    let opObj: Operation | null = null
    if (op === 'replace') {
      if (current === undefined) { reject('路径不存在'); continue }
      if (typeof current === 'string') {
        if (typeof c.value !== 'string' || !c.value.trim()) { reject('replace 的 value 必须是非空字符串'); continue }
        if (typeof c.original === 'string' && norm(c.original) !== norm(current)) { reject('original 与简历原文不一致'); continue }
        opObj = { op: 'replace', path, value: c.value.trim() }
      } else if (Array.isArray(current)) {
        if (!Array.isArray(c.value)) { reject('数组路径的 replace 需要数组 value'); continue }
        if (!sameMultiset(current, c.value)) { reject('对数组的 replace 只允许重排（元素必须相同）；新增请用 add'); continue }
        opObj = { op: 'replace', path, value: c.value }
      } else { reject('路径类型不支持'); continue }
    } else if (op === 'reorder') {
      if (!Array.isArray(current)) { reject('reorder 的 path 必须指向数组'); continue }
      if (!Array.isArray(c.value) || !sameMultiset(current, c.value)) { reject('reorder 的 value 必须是原数组的重排'); continue }
      opObj = { op: 'replace', path, value: c.value }
    } else if (op === 'add') {
      if (rule.kind !== 'array' || !Array.isArray(current)) { reject('add 的 path 必须指向 bullets / keywords 数组'); continue }
      if (typeof c.value !== 'string' || !c.value.trim()) { reject('add 的 value 必须是非空字符串'); continue }
      const valid = claim_ids.filter(id => claimIdSet.has(id))
      if (valid.length === 0) { reject('新增内容必须引用至少一条已确认主张（claim_ids）'); continue }
      opObj = { op: 'add', path: `${path}/-`, value: c.value.trim() }
    } else if (op === 'remove') {
      if (rule.kind !== 'element' || current === undefined) { reject('remove 只能删除单条 bullet / 关键词'); continue }
      if (typeof c.original === 'string' && norm(c.original) !== norm(String(current))) { reject('original 与简历原文不一致'); continue }
      opObj = { op: 'remove', path }
    }
    if (!opObj) { reject('未知操作'); continue }

    // 编造检测：只对新文本做
    const flags: TruthFlag[] = []
    const newValue: unknown = (opObj as { value?: unknown }).value
    const newText = typeof newValue === 'string' ? newValue : Array.isArray(newValue) ? newValue.filter((x): x is string => typeof x === 'string').join('\n') : ''
    if (newText) flags.push(...findFabrications(newText, corpus).map(f => ({ ...f, path: opObj!.path })))
    if (flags.length && ctx.rejectFlagged) { reject('疑似编造：' + flags.map(f => f.token).join('、')); continue }

    try {
      const r = applyPatch(deepClone(working), [opObj], true, false)
      working = ResumeSchema.parse(r.newDocument)
    } catch (e) { reject('应用改动失败：' + (e instanceof Error ? e.message : String(e))); continue }
    patch.push(opObj)
    rationale.push({ path: opObj.path, op: opObj.op, reason, original: current, value: (opObj as { value?: unknown }).value, claim_ids, flags })
  }

  // 新增 bullet 的 claim_ids 回写到条目，保持"每条内容可追溯"。
  for (const r of rationale) if (r.op === 'add' && r.claim_ids.length) attachClaimIds(working, r.path, r.claim_ids)

  return { proposed: working, patch, rationale, truthfulnessFlags: rationale.flatMap(r => r.flags), rejected, strategyNotes: ctx.strategyNotes, usableClaims: ctx.usableClaims, excludedClaims: ctx.excludedClaims }
}

function attachClaimIds(resume: Resume, bulletPath: string, ids: string[]) {
  const entryPath = bulletPath.replace(/\/bullets\/(\d+|-)$/, '')
  if (entryPath === bulletPath) return
  const entry = getValueByPointer(resume, entryPath) as { claim_ids?: string[] } | undefined
  if (entry && Array.isArray(entry.claim_ids)) entry.claim_ids = [...new Set([...entry.claim_ids, ...ids])]
}

function norm(s: string): string { return s.replace(/\s+/g, '').trim() }
function sameMultiset(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  const key = (x: unknown) => JSON.stringify(x)
  return [...a].map(key).sort().join('\u0000') === [...b].map(key).sort().join('\u0000')
}

// ---------- 编造检测 ----------

export interface TruthCorpus { numbers: Set<string>; terms: Set<string> }

export function buildCorpus(master: Resume, claims: Claim[]): TruthCorpus {
  const text = [resumeText(master), ...claims.map(c => `${c.text} ${c.result_metric ?? ''}`)].join('\n')
  return { numbers: new Set(extractNumbers(text)), terms: new Set(extractTerms(text)) }
}

/** 数字（含小数、千分位、百分比、中文单位前的数字）；归一化去掉千分位逗号。 */
export function extractNumbers(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map(n => n.replace(/,/g, ''))
}

/** 专有名词：拉丁字母词（工具、框架、机构缩写）与书名号 / 引号内的短语，统一小写。 */
export function extractTerms(text: string): string[] {
  const latin = (text.match(/[A-Za-z][A-Za-z0-9+#.\-]*/g) ?? []).map(t => t.replace(/[.\-]+$/, '').toLowerCase()).filter(t => t.length >= 2)
  const quoted = [...text.matchAll(/[《「“"『]([^》」”"』]{2,30})[》」”"』]/g)].map(m => m[1].trim().toLowerCase())
  return [...latin, ...quoted]
}

const TERM_WHITELIST = new Set(['pdf', 'docx', 'png', 'jd', 'hr', 'word', 'excel', 'ppt', 'office', 'ok'])

/** 新文本里出现、但语料（master + 已确认主张）里没有的数字 / 专有名词。 */
export function findFabrications(text: string, corpus: TruthCorpus): Omit<TruthFlag, 'path'>[] {
  const out: Omit<TruthFlag, 'path'>[] = []
  for (const n of new Set(extractNumbers(text))) if (!corpus.numbers.has(n)) out.push({ kind: 'number', token: n, text, reason: `数字 ${n} 未在简历原文或已确认主张中出现` })
  for (const t of new Set(extractTerms(text))) if (!corpus.terms.has(t) && !TERM_WHITELIST.has(t)) out.push({ kind: 'term', token: t, text, reason: `名词 ${t} 未在简历原文或已确认主张中出现` })
  return out
}

// ---------- bullet 相关度打分 ----------

export interface RelevanceScore { path: string; text: string; score: number; source: 'llm' | 'heuristic' }

export const RELEVANCE_SYSTEM_PROMPT = `你是简历与岗位匹配度评估助手。对给出的每条简历 bullet 打分 0-100：0 = 与岗位无关，100 = 直接证明核心要求。
加分：证明了硬技能、关键职责、有可量化结果。不要改写、合并、重排或新增 bullet；path 逐字复制。
输出严格 JSON：{ "scores": [ { "path": "...", "score": 87 } ] }`

export async function bulletRelevance(llm: LLM, bullets: Array<BulletRef | { path: string; text: string }> | string[], jd: JdParsed): Promise<RelevanceScore[]> {
  const list = bullets.map((b, i) => typeof b === 'string' ? { path: `/${i}`, text: b } : { path: b.path, text: b.text })
  if (list.length === 0) return []
  const user = [
    `【岗位】${jd.company ?? ''} ${jd.title ?? ''}`.trim(),
    `【硬性门槛】\n${jd.hard_requirements.map(s => '- ' + s).join('\n') || '（无）'}`,
    `【岗位职责】\n${jd.responsibilities.map(s => '- ' + s).join('\n') || '（无）'}`,
    `【关键词】${jdKeywordList(jd).join('、') || '（无）'}`,
    `【bullets】（path | 文本）\n${list.map(b => `${b.path} | ${b.text}`).join('\n')}`,
  ].join('\n\n')
  const res = await llm.complete({ system: RELEVANCE_SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], json: true, temperature: 0 })
  const raw = extractJson<{ scores?: Array<{ path?: string; score?: number }> }>(res.text)
  const byPath = new Map<string, number>()
  for (const s of raw.scores ?? []) if (typeof s?.path === 'string' && typeof s.score === 'number' && Number.isFinite(s.score)) byPath.set(s.path, Math.max(0, Math.min(100, Math.round(s.score))))
  return list.map(b => byPath.has(b.path) ? { ...b, score: byPath.get(b.path)!, source: 'llm' as const } : { ...b, score: heuristicRelevance(b.text, jd), source: 'heuristic' as const })
}

/** 无模型时的兜底打分：关键词命中数 + 有无数字。 */
export function heuristicRelevance(text: string, jd: JdParsed): number {
  const kws = jdKeywordList(jd)
  const lower = text.toLowerCase()
  const hits = kws.filter(k => lower.includes(k.toLowerCase())).length
  let score = Math.min(70, hits * 25)
  if (/\d/.test(text)) score += 15
  if (text.length >= 12) score += 5
  return Math.min(100, score)
}

// ---------- 页数预算裁剪 ----------

export interface FitOptions {
  /** bullet 打分（按 path 或按文本匹配）；没有的用启发式。 */
  scores?: RelevanceScore[] | Record<string, number>
  jd?: JdParsed
  /** 默认模板下每页可用正文行数（A4、10pt、行高 1.42 约 50 行）。 */
  linesPerPage?: number
}
export interface FitResult { resume: Resume; removed: Array<{ path: string; text: string; score: number }>; estimatedLines: number; budgetLines: number; fits: boolean }

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/

/** 文本显示宽度（中文 1、西文 0.5），用于同分时的排序。 */
export function textWidth(s: string): number { let w = 0; for (const ch of s) w += CJK_RE.test(ch) ? 1 : 0.5; return w }

const FS = CLASSIC_CN.fontSize
const bulletLines = (t: string) => (t ? wrapText(t, CLASSIC_CN.contentWidth - CLASSIC_CN.bulletIndent, FS).length : 0)
const fullLines = (t: string) => (t ? wrapText(t, CLASSIC_CN.contentWidth, FS).length : 0)

/** 按 ClassicCN 模板的真实度量估算行数（分区标题按 1.6 行、条目标题 1 行）。 */
export function estimateLines(resume: Resume): number {
  const b = resume.basics
  const midW = CLASSIC_CN.contentWidth - 2 * CLASSIC_CN.headerSide
  let lines = 1.6 // 姓名
  lines += packSegments([b.phone, b.email, b.city], '  |  ', midW, FS).length
  lines += packSegments([b.objective, b.target_cities.join('/'), b.expected_salary, b.political_status, b.availability].map(x => (x ? '占位：' + x : '')), '  |  ', midW, FS).length
  const section = (count: number) => (count > 0 ? 1.6 : 0)
  for (const key of orderedSections(resume)) {
    if (key === 'education') { lines += section(resume.education.length); for (const e of resume.education) lines += 1 + (e.courses.length ? fullLines('核心课程：' + e.courses.join('、')) : 0) + e.bullets.reduce((a, t) => a + bulletLines(t), 0) }
    if (key === 'experience') { lines += section(resume.experience.length); for (const e of resume.experience) { lines += 1 + e.bullets.reduce((a, t) => a + bulletLines(t), 0); for (const r of e.roles) lines += 1 + r.bullets.reduce((a, t) => a + bulletLines(t), 0) } }
    if (key === 'projects') { lines += section(resume.projects.length); for (const p of resume.projects) lines += 1 + p.bullets.reduce((a, t) => a + bulletLines(t), 0) }
    if (key === 'skills') { lines += section(resume.skills.length); for (const s of resume.skills) lines += fullLines(`${s.name}：${s.keywords.join('、')}${s.level ? `（${s.level}）` : ''}`) }
    if (key === 'awards') { lines += section(resume.awards.length); lines += resume.awards.length }
    if (key === 'certifications') { lines += section(resume.certifications.length); lines += fullLines(resume.certifications.map(c => [c.title, c.issuer, c.date].filter(Boolean).join(' ')).join('；')) }
    if (key === 'custom_sections') for (const s of resume.custom_sections) { lines += section(s.items.length); for (const it of s.items) lines += (it.title || it.date ? 1 : 0) + it.bullets.reduce((a, t) => a + bulletLines(t), 0) }
  }
  return Math.ceil(lines)
}

/**
 * 用简单字数预算把简历裁到 maxPages 页：反复删掉相关度最低的 bullet（优先删多 bullet 条目里的），
 * 其次删低分的补充信息条目 / 奖项。不会缩字号、不会压行距。
 */
export function fitToPages(resume: Resume, maxPages = 1, opts: FitOptions = {}): FitResult {
  const linesPerPage = opts.linesPerPage ?? 50
  const budget = Math.floor(maxPages * linesPerPage)
  const byPath = new Map<string, number>(); const byText = new Map<string, number>()
  if (Array.isArray(opts.scores)) for (const s of opts.scores) { byPath.set(s.path, s.score); byText.set(s.text, s.score) }
  else if (opts.scores) for (const [p, s] of Object.entries(opts.scores)) byPath.set(p, s)
  const scoreOf = (b: { path: string; text: string }) => byPath.get(b.path) ?? byText.get(b.text) ?? (opts.jd ? heuristicRelevance(b.text, opts.jd) : 50)

  let work: Resume = deepClone(resume)
  const removed: FitResult['removed'] = []
  // 初始打分固定一次（路径会随删除变化，所以按文本缓存）。
  for (const b of listBullets(work)) byText.set(b.text, scoreOf(b))

  let guard = 0
  while (estimateLines(work) > budget && guard++ < 500) {
    const bullets = listBullets(work)
    const countByEntry = new Map<string, number>()
    for (const b of bullets) countByEntry.set(entryOf(b.path), (countByEntry.get(entryOf(b.path)) ?? 0) + 1)
    // 候选：所在条目还有 ≥2 条 bullet 的；没有的话任何 bullet 都可删。
    let cands = bullets.filter(b => (countByEntry.get(entryOf(b.path)) ?? 0) >= 2)
    if (cands.length === 0) cands = bullets
    if (cands.length > 0) {
      cands.sort((a, b) => (byText.get(a.text) ?? 50) - (byText.get(b.text) ?? 50) || textWidth(b.text) - textWidth(a.text))
      const victim = cands[0]
      work = applyPatch(work, [{ op: 'remove', path: victim.path }], true, false).newDocument
      removed.push({ path: victim.path, text: victim.text, score: byText.get(victim.text) ?? 50 })
      continue
    }
    // 没有 bullet 可删了：删补充信息条目，再删奖项
    const cs = work.custom_sections.findIndex(s => s.items.length > 0)
    if (cs >= 0) { const it = work.custom_sections[cs].items.pop()!; removed.push({ path: `/custom_sections/${cs}/items/${work.custom_sections[cs].items.length}`, text: it.title, score: 0 }); continue }
    if (work.awards.length > 0) { const a = work.awards.pop()!; removed.push({ path: `/awards/${work.awards.length}`, text: a.title, score: 0 }); continue }
    break
  }
  work.custom_sections = work.custom_sections.filter(s => s.items.length > 0)
  const estimatedLines = estimateLines(work)
  return { resume: work, removed, estimatedLines, budgetLines: budget, fits: estimatedLines <= budget }
}

function entryOf(bulletPath: string): string { return bulletPath.replace(/\/bullets\/\d+$/, '') }
