/**
 * campus-radar 桥接：读取 modules/campus-radar/jobs.json（校招/实习信息，静态数据）。
 * 字段：company 公司 / cohort 届别 / batch 批次 / program 项目名 / industry 行业 / positions 岗位 /
 *       locations 地点 / apply_url 网申链接 / official_wechat 官方公众号 / qr_image 二维码 /
 *       deadline 截止日期 / campus_only 是否仅限校招 / first_seen、last_seen 首次/最后收录 / confirmed_by 确认人数
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { inferEmploymentType, normalizeCohort, serializeBoardMeta, type EmploymentType, type Repos, type Job } from '@career/core'
import { moduleDir } from './common.js'

export const CampusJobSchema = z.object({
  company: z.string(),
  cohort: z.string().nullish(),
  batch: z.string().nullish(),
  program: z.string().nullish(),
  industry: z.string().nullish(),
  positions: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  apply_url: z.string().nullish(),
  official_wechat: z.string().nullish(),
  qr_image: z.string().nullish(),
  deadline: z.string().nullish(),
  campus_only: z.boolean().nullish(),
  first_seen: z.string().nullish(),
  last_seen: z.string().nullish(),
  confirmed_by: z.number().nullish(),
}).passthrough()
export type CampusJob = z.infer<typeof CampusJobSchema>

/**
 * jobs.json 的位置，按顺序取第一个存在的：
 *  1. 环境变量 CAMPUS_RADAR_JOBS（文件）/ CAMPUS_RADAR_DIR（目录）——显式指定时直接用，不再回退；
 *  2. <stackRoot>/modules/campus-radar/jobs.json——开发时是仓库根；发布包里 @career/bridges 部署在
 *     Resources/node_modules/@career/bridges/dist，stackRoot 正好落在 Resources，tauri.conf 把 jobs.json 映射到
 *     Resources/modules/campus-radar/jobs.json（scripts/stage-career-packages.mjs 负责拷过去）；
 *  3. 侧车入口（server-dist.js）同级的 modules/campus-radar/jobs.json——万一领域库不在 Resources 下也能找到。
 * 都不存在时返回第 2 个（报错信息里的路径最有指向性）。
 */
export function defaultCampusJobsPath(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): string {
  const file = env.CAMPUS_RADAR_JOBS?.trim()
  if (file) return file
  const dir = env.CAMPUS_RADAR_DIR?.trim()
  if (dir) return join(dir, 'jobs.json')
  const primary = join(moduleDir('campus-radar'), 'jobs.json')
  const candidates = [primary, ...(entry ? [join(dirname(entry), 'modules', 'campus-radar', 'jobs.json')] : [])]
  return candidates.find(p => existsSync(p)) ?? primary
}

/** 读取并校验 jobs.json；坏条目跳过而不是整体失败。 */
export function loadCampusJobs(path = defaultCampusJobsPath()): CampusJob[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error(`campus-radar jobs.json 不是数组：${path}`)
  const out: CampusJob[] = []
  for (const item of raw) { const r = CampusJobSchema.safeParse(item); if (r.success) out.push(r.data) }
  return out
}

export interface CampusFilter {
  industry?: string
  /** 匹配公司 / 项目名 / 岗位 / 行业 / 地点（不区分大小写）。 */
  keyword?: string
  /** 截止日期在今天起 N 天内（含无截止日期的条目用 includeNoDeadline 控制）。 */
  deadlineWithinDays?: number
  includeNoDeadline?: boolean
  /** 过滤掉已过期（默认 true）。 */
  excludeExpired?: boolean
  cohort?: string
  batch?: string
  location?: string
  campusOnly?: boolean
  /** 测试用：固定"今天"（YYYY-MM-DD）。 */
  today?: string
}

const dayMs = 86_400_000
const parseDate = (s: string | null | undefined): number | null => { if (!s) return null; const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s); return Number.isFinite(t) ? t : null }

export function filterCampusJobs(items: CampusJob[], f: CampusFilter = {}): CampusJob[] {
  const todayMs = parseDate(f.today) ?? Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  const kw = f.keyword?.trim().toLowerCase()
  const excludeExpired = f.excludeExpired ?? true
  return items.filter(j => {
    if (f.industry && (j.industry ?? '') !== f.industry) return false
    if (f.cohort && (j.cohort ?? '') !== f.cohort) return false
    if (f.batch && (j.batch ?? '') !== f.batch) return false
    if (f.campusOnly !== undefined && !!j.campus_only !== f.campusOnly) return false
    if (f.location && !j.locations.some(l => l.includes(f.location!))) return false
    if (kw) {
      const hay = [j.company, j.program, j.industry, j.cohort, j.batch, ...j.positions, ...j.locations].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(kw)) return false
    }
    const dl = parseDate(j.deadline)
    if (dl === null) { if (f.deadlineWithinDays !== undefined && !f.includeNoDeadline) return false; return true }
    if (excludeExpired && dl < todayMs) return false
    if (f.deadlineWithinDays !== undefined && dl > todayMs + f.deadlineWithinDays * dayMs) return false
    return true
  }).sort((a, b) => (parseDate(a.deadline) ?? Infinity) - (parseDate(b.deadline) ?? Infinity))
}

/** 稳定的 source_job_id：公司+届别+批次+项目+岗位 的哈希。 */
export function campusJobId(j: CampusJob): string {
  const key = [j.company, j.cohort ?? '', j.batch ?? '', j.program ?? '', [...j.positions].sort().join('|')].join('\u0001')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

export function campusJobTitle(j: CampusJob): string {
  if (j.positions.length) return j.positions.length <= 3 ? j.positions.join(' / ') : `${j.positions.slice(0, 3).join(' / ')} 等${j.positions.length}个岗位`
  return j.program || [j.cohort, j.batch].filter(Boolean).join(' ') || `${j.company} 招聘`
}

/** 校招数据里没写批次的默认按校招算。 */
export function campusEmploymentType(j: CampusJob): EmploymentType {
  const t = inferEmploymentType(j.batch, j.program, campusJobTitle(j))
  return t === 'unknown' ? 'campus' : t
}

export function mapCampusJob(j: CampusJob): Parameters<Repos['upsertJob']>[0] {
  const lines = [
    `公司：${j.company}`, j.industry ? `行业：${j.industry}` : null, j.cohort ? `届别：${j.cohort}` : null, j.batch ? `批次：${j.batch}` : null,
    j.program ? `项目：${j.program}` : null, j.positions.length ? `岗位：${j.positions.join('、')}` : null, j.locations.length ? `地点：${j.locations.join('、')}` : null,
    j.apply_url ? `网申链接：${j.apply_url}` : null, j.official_wechat ? `官方公众号：${j.official_wechat}` : null, j.qr_image ? `二维码：${j.qr_image}` : null,
    j.deadline ? `截止日期：${j.deadline}（未核验）` : '截止日期：未知', j.campus_only != null ? `仅限校招：${j.campus_only ? '是' : '否'}` : null,
    j.first_seen ? `收录：${j.first_seen} ~ ${j.last_seen ?? j.first_seen}，确认人数 ${j.confirmed_by ?? 0}` : null,
  ].filter((s): s is string => !!s)
  return {
    source_platform: 'campus',
    source_job_id: campusJobId(j),
    employment_type: campusEmploymentType(j),
    cohort: normalizeCohort(j.cohort),
    url: j.apply_url ?? null,
    company_name: j.company,
    title: campusJobTitle(j),
    location: j.locations.length ? j.locations.join('/') : null,
    salary: null,
    jd_raw: lines.join('\n'),
    deadline: j.deadline ?? null,
    deadline_verified_at: null,
    // 汇总表维度单独存 board_json（岗位评估会重写 prefilter_json）；prefilter_json.campus 保留原始字段供兼容读取
    board_json: serializeBoardMeta({ batch: j.batch, industry: j.industry }),
    prefilter_json: JSON.stringify({ campus: { cohort: j.cohort ?? null, batch: j.batch ?? null, program: j.program ?? null, industry: j.industry ?? null, positions: j.positions, official_wechat: j.official_wechat ?? null, qr_image: j.qr_image ?? null, campus_only: j.campus_only ?? null, confirmed_by: j.confirmed_by ?? null, first_seen: j.first_seen ?? null, last_seen: j.last_seen ?? null } }),
  }
}

/** 写入 job 表：source_platform='campus'，deadline 未核验（deadline_verified_at 为 null）。 */
export function importCampusJobs(repos: Repos, items: CampusJob[]): Job[] {
  const out: Job[] = []
  repos.db.transaction(() => { for (const j of items) out.push(repos.upsertJob(mapCampusJob(j))) })
  return out
}
