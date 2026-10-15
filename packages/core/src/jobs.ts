/**
 * 岗位来源契约：本地库、校招静态数据（campus-radar）、服务端共享岗位库都实现同一个 JobSource。
 * 服务端（PostgreSQL）由后端团队实现 docs/SERVER-API.md 里的 HTTP 接口；客户端只认这个契约，不直连数据库。
 *
 * 身份：job_key（见 keys.ts 的 jobKey）在客户端与服务端一致；服务端去重 / 下架后仍保留 job_key 与历史版本，
 * 本地投递记录通过材料包里的 JD 快照永远能找回当时那份 JD。
 */
export const EMPLOYMENT_TYPES = ['campus', 'intern', 'social', 'unknown'] as const
export type EmploymentType = typeof EMPLOYMENT_TYPES[number]

export interface JobListing {
  job_key: string
  /** 服务端岗位 id（本地 / 静态来源为空）。 */
  remote_id?: string | null
  source_platform: string
  source_job_id?: string | null
  url?: string | null
  company_name: string
  title: string
  location?: string | null
  employment_type?: EmploymentType
  /** 届别，如 2027届。 */
  cohort?: string | null
  salary?: string | null
  jd_raw?: string | null
  deadline?: string | null
  deadline_verified_at?: string | null
  /** 服务端版本号（JD 改动 +1）；本地据此判断要不要更新。 */
  version?: number | null
  updated_at?: string | null
  /** 下架 / 被合并（tombstone）：本地保留但标记，不再推荐。 */
  status?: 'open' | 'closed' | 'merged'
  merged_into?: string | null
  /** 汇总表维度（可选，服务端有就带）：批次（正式批 / 提前批 / 实习…）、行业、类型标签（央国企 / 外企…）。见 JobBoardMeta。 */
  batch?: string | null
  industry?: string | null
  type_tags?: string[] | null
}

export interface JobQuery {
  q?: string
  employment_type?: EmploymentType
  city?: string
  cohort?: string
  /** 只要截止日期在这之后的（YYYY-MM-DD）。 */
  deadline_after?: string
  /** 增量同步：只要这之后更新过的。 */
  updated_since?: string
  cursor?: string
  limit?: number
}

export interface JobPage { items: JobListing[]; next_cursor?: string | null }

export interface JobSource {
  readonly id: string
  search(query: JobQuery): Promise<JobPage>
}

/** 从"批次 / 标题 / JD"里判断校招 / 实习 / 社招。 */
export function inferEmploymentType(...texts: Array<string | null | undefined>): EmploymentType {
  const t = texts.filter(Boolean).join(' ')
  if (/实习|intern/i.test(t)) return 'intern'
  if (/校招|校园招聘|秋招|春招|应届|毕业生|管培|届|campus|graduate/i.test(t)) return 'campus'
  if (/社招|社会招聘|经验\s*\d|\d+\s*年以上/i.test(t)) return 'social'
  return 'unknown'
}

/** 届别归一：2027届 / 27届 / 2027 年毕业 → 2027届。 */
export function normalizeCohort(raw: string | null | undefined): string | null {
  if (!raw) return null
  // 只认带"届 / 毕业"的写法；整串就是年份（如 cohort 字段填了 2027）也算。JD 里散落的日期年份不算。
  const m = raw.match(/(20)?(\d{2})\s*(届|年毕业|年应届|graduates?)/i) ?? raw.trim().match(/^(20)(\d{2})$/)
  return m ? `20${m[2]}届` : null
}

/** 用户的求职条件（明确条件；岗位推荐不得违反）。存在 kv `profile.job_prefs`。 */
export interface JobPrefs {
  cohort?: string | null
  /** 最高学历：大专 / 本科 / 硕士 / 博士 */
  degree?: string | null
  cities?: string[]
  employment_types?: EmploymentType[]
  /** 想要的方向关键词（加分，不是硬条件）。 */
  keywords?: string[]
}
export const JOB_PREFS_KEY = 'profile.job_prefs'

// ===== 岗位汇总表维度（批次 / 行业 / 类型标签）=====
/**
 * 存在 job.board_json（迁移 v7），形如 `{"batch":"正式批","industry":"互联网","type_tags":["央国企"]}`：
 *  - 只放来源数据里**明确写着**的值（校招静态数据 / 服务端岗位库 / 手动导入时用户填的 / JD 或邮件原文里字面出现的批次词），拿不到就是 null / []，不猜；
 *  - 由各导入路径写入，岗位评估（job_evaluate 写 prefilter_json / score_json）永远不碰这一列；
 *  - 同一岗位被多个来源写入时按字段合并（新值非空才覆盖，类型标签取并集），见 Repos.upsertJob。
 * 老数据没有 board_json 时，读取方回退到 prefilter_json.campus（campus-radar 早期写法）。
 */
export interface JobBoardMeta { batch: string | null; industry: string | null; type_tags: string[] }
export interface JobBoardInput { batch?: unknown; industry?: unknown; type_tags?: unknown }

/** 校招来源把「央国企 / 外企 / 事业单位」这类企业性质也写在行业里：归到类型标签，行业只留真正的行业。 */
export const OWNERSHIP_RE = /央企|国企|央国企|外企|外资|合资|民企|事业单位|研究所|军工/

const boardText = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.trim() !== '其他' ? v.trim() : null)

export function normalizeBoardMeta(raw: JobBoardInput | null | undefined): JobBoardMeta {
  const industryRaw = boardText(raw?.industry)
  const ownership = !!industryRaw && OWNERSHIP_RE.test(industryRaw)
  const tags = new Set<string>()
  if (ownership && industryRaw) tags.add(industryRaw)
  if (Array.isArray(raw?.type_tags)) for (const t of raw!.type_tags as unknown[]) { const s = boardText(t); if (s) tags.add(s) }
  return { batch: boardText(raw?.batch), industry: ownership ? null : industryRaw, type_tags: [...tags] }
}

export function isEmptyBoardMeta(m: JobBoardMeta): boolean { return !m.batch && !m.industry && m.type_tags.length === 0 }

/** 写 job.board_json 用：全空返回 undefined（upsert 时不覆盖已有值）。 */
export function serializeBoardMeta(raw: JobBoardInput | null | undefined): string | undefined {
  const m = normalizeBoardMeta(raw)
  return isEmptyBoardMeta(m) ? undefined : JSON.stringify(m)
}

/** 读 job.board_json；没有 / 坏 JSON 返回 null。 */
export function parseBoardJson(raw: string | null | undefined): JobBoardMeta | null {
  if (!raw) return null
  try { const v = JSON.parse(raw) as unknown; return v && typeof v === 'object' ? normalizeBoardMeta(v as JobBoardInput) : null } catch { return null }
}

/** 字段级合并：patch 的非空值覆盖 base，类型标签取并集。 */
export function mergeBoardMeta(base: JobBoardMeta | null, patch: JobBoardMeta | null): JobBoardMeta {
  const b = base ?? { batch: null, industry: null, type_tags: [] }
  if (!patch) return b
  return { batch: patch.batch ?? b.batch, industry: patch.industry ?? b.industry, type_tags: [...new Set([...b.type_tags, ...patch.type_tags])] }
}

/** 原文里字面出现的批次词（按具体程度排序，取第一个命中）；没有就 null。 */
const BATCH_WORDS = ['提前批', '正式批', '补录', '暑期实习', '日常实习', '春招', '秋招'] as const
export function batchFromText(...texts: Array<string | null | undefined>): string | null {
  const t = texts.filter(Boolean).join('\n')
  return BATCH_WORDS.find(w => t.includes(w)) ?? null
}

/**
 * JD 解析结果 → 汇总表维度：只认解析结果里显式的 industry / batch / company_type 字段（jd-parse 输出若带上就用），
 * 外加原文里字面出现的批次词、notes 里字面出现的企业性质词。不从别的字段推断行业。
 */
export function boardMetaFromJd(parsed: { industry?: unknown; batch?: unknown; company_type?: unknown; notes?: unknown } | null | undefined, ...texts: Array<string | null | undefined>): JobBoardInput {
  const tags: string[] = []
  const companyType = boardText(parsed?.company_type)
  if (companyType) tags.push(companyType)
  const notes = Array.isArray(parsed?.notes) ? (parsed!.notes as unknown[]).filter((n): n is string => typeof n === 'string') : []
  for (const n of notes) { const m = n.match(OWNERSHIP_RE); if (m) tags.push(m[0]) }
  return { batch: boardText(parsed?.batch) ?? batchFromText(...texts), industry: parsed?.industry, type_tags: tags }
}
