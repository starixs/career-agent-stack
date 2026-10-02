import { describe, it, expect } from 'vitest'
import { loadCampusJobs, filterCampusJobs, importCampusJobs, campusJobId, defaultCampusJobsPath, type CampusJob } from '../src/index.js'
import { memRepos } from './helpers.js'

const jobs = loadCampusJobs()

describe('campusRadar 加载（真实 jobs.json）', () => {
  it('默认路径指向 modules/campus-radar/jobs.json，读到 443 条', () => {
    expect(defaultCampusJobsPath()).toMatch(/modules\/campus-radar\/jobs\.json$/)
    expect(jobs.length).toBe(443)
    expect(jobs[0]).toMatchObject({ company: '高盛', cohort: '2027届' })
    expect(Array.isArray(jobs[0].positions)).toBe(true)
  })
})

describe('filterCampusJobs', () => {
  it('按行业与关键词过滤', () => {
    const industries = new Set(jobs.map(j => j.industry).filter(Boolean))
    expect(industries.has('外企')).toBe(true)
    const foreign = filterCampusJobs(jobs, { industry: '外企', excludeExpired: false })
    expect(foreign.length).toBeGreaterThan(0)
    expect(foreign.every(j => j.industry === '外企')).toBe(true)
    const gs = filterCampusJobs(jobs, { keyword: '高盛', excludeExpired: false })
    expect(gs.length).toBeGreaterThan(0)
    expect(gs.every(j => j.company.includes('高盛') || j.positions.some(p => p.includes('高盛')))).toBe(true)
    expect(filterCampusJobs(jobs, { keyword: '不存在的公司XYZ' })).toEqual([])
  })

  it('deadlineWithinDays 以固定 today 计算，结果按截止日升序，过期默认剔除', () => {
    const today = '2026-10-01'
    const soon = filterCampusJobs(jobs, { deadlineWithinDays: 7, today })
    expect(soon.length).toBeGreaterThan(0)
    for (const j of soon) { expect(j.deadline! >= today).toBe(true); expect(j.deadline! <= '2026-10-08').toBe(true) }
    for (let i = 1; i < soon.length; i++) expect(soon[i - 1].deadline! <= soon[i].deadline!).toBe(true)
    // 无截止日期的默认不进 deadlineWithinDays 结果，includeNoDeadline 可带上
    const withNone = filterCampusJobs(jobs, { deadlineWithinDays: 7, today, includeNoDeadline: true })
    expect(withNone.length).toBeGreaterThanOrEqual(soon.length)
    expect(filterCampusJobs(jobs, { today: '2030-01-01' }).every(j => !j.deadline)).toBe(true)
  })
})

describe('importCampusJobs → job 表', () => {
  it("source_platform='campus'，deadline 未核验，重复导入不重复", () => {
    const repos = memRepos()
    const sample = filterCampusJobs(jobs, { today: '2026-07-01' }).slice(0, 5)
    const rows = importCampusJobs(repos, sample)
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(r.source_platform).toBe('campus')
      expect(r.source_job_id).toHaveLength(16)
      expect(r.deadline_verified_at).toBeNull()
      expect(r.company_name).toBeTruthy()
      expect(r.jd_raw).toContain('公司：')
    }
    const gs = sample.find(j => j.company === '高盛') ?? sample[0]
    const row = rows.find(r => r.source_job_id === campusJobId(gs))!
    expect(row.deadline).toBe(gs.deadline ?? null)
    expect(row.location).toBe(gs.locations.length ? gs.locations.join('/') : null)
    importCampusJobs(repos, sample)
    expect(repos.listJobs()).toHaveLength(5)
  })

  it('标题：岗位 ≤3 个直接拼接，更多则加"等 N 个岗位"；无岗位用项目名', () => {
    const base: CampusJob = { company: 'C', positions: [], locations: [] }
    const rows = importCampusJobs(memRepos(), [
      { ...base, positions: ['a', 'b'] },
      { ...base, positions: ['a', 'b', 'c', 'd'] },
      { ...base, program: '管培生计划' },
    ])
    expect(rows.map(r => r.title)).toEqual(['a / b', 'a / b / c 等4个岗位', '管培生计划'])
  })
})
