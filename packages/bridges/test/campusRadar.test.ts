import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { applyChannelOf, parseBoardJson } from '@career/core'
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

  it('环境变量优先；没有环境变量时取第一个存在的候选路径', () => {
    expect(defaultCampusJobsPath({ CAMPUS_RADAR_JOBS: '/x/jobs.json' })).toBe('/x/jobs.json')
    expect(defaultCampusJobsPath({ CAMPUS_RADAR_DIR: '/y' })).toBe(join('/y', 'jobs.json'))
    // 开发布局下仓库里的 jobs.json 存在，优先它
    expect(defaultCampusJobsPath({}, '/nowhere/server-dist.js')).toMatch(/modules\/campus-radar\/jobs\.json$/)
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

  it('requireApplyUrl：只留有网申链接的（空白链接不算）；默认不筛', () => {
    const withLink = filterCampusJobs(jobs, { excludeExpired: false, requireApplyUrl: true })
    expect(withLink.length).toBeGreaterThan(0)
    expect(withLink.length).toBeLessThan(jobs.length)
    expect(withLink.every(j => !!j.apply_url?.trim())).toBe(true)
    expect(filterCampusJobs(jobs, { excludeExpired: false }).length).toBe(jobs.length)
    expect(filterCampusJobs([{ company: '甲', positions: [], locations: [], apply_url: '  ' }], { requireApplyUrl: true })).toEqual([])
  })

  it('requireApplyWay：有网申链接或有合法投递邮箱都收（2026-11-05 岗位库放开到邮件投递）；都没有、邮箱不合法的不收', () => {
    const items = [
      { company: '有链接', positions: [], locations: [], apply_url: 'https://a.com/x' },
      { company: '只有邮箱', positions: [], locations: [], apply_email: ' hr@yi.com ' },
      { company: '邮箱不合法', positions: [], locations: [], apply_email: 'hr' },
      { company: '都没有', positions: [], locations: [], apply_url: ' ' },
    ]
    expect(filterCampusJobs(items, { excludeExpired: false, requireApplyWay: true }).map(j => j.company)).toEqual(['有链接', '只有邮箱'])
    expect(filterCampusJobs(items, { excludeExpired: false, requireApplyUrl: true }).map(j => j.company)).toEqual(['有链接'])
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

  it('只有投递邮箱的条目：入库时写进 job.apply_email、走邮件通道，JD 里也写明；没有网申链接不报错', () => {
    const repos = memRepos()
    const [row] = importCampusJobs(repos, [{ company: '乙数据', positions: ['产品实习生'], locations: [], batch: '实习', apply_email: ' hr@yi.com ' }])
    expect(row).toMatchObject({ url: null, apply_email: 'hr@yi.com' })
    expect(row.jd_raw).toContain('投递邮箱：hr@yi.com')
    expect(applyChannelOf(row)).toBe('mail')
  })

  it('批次 / 行业写进 board_json（企业性质归类型标签），评估重写 prefilter_json 也不丢', () => {
    const repos = memRepos()
    const [row] = importCampusJobs(repos, [{ company: '国网', positions: ['电气'], locations: [], batch: '正式批', industry: '央国企' }])
    expect(parseBoardJson(row.board_json)).toEqual({ batch: '正式批', industry: null, type_tags: ['央国企'] })
    repos.db.update('job', row.id, { prefilter_json: JSON.stringify({ evaluation: { pass: true } }) })
    expect(parseBoardJson(repos.getJob(row.id)!.board_json)).toEqual({ batch: '正式批', industry: null, type_tags: ['央国企'] })
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
