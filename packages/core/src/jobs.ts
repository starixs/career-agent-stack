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
