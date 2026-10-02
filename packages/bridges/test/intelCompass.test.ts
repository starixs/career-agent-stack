import { describe, it, expect } from 'vitest'
import { IntelCompassClient, normalizeDdReport, saveReport, loadReport, intelCompassCommand } from '../src/index.js'
import { fakeFetch, memRepos } from './helpers.js'

const rawReport = {
  company: '亿达信息',
  basic: {
    resolve: { matched: true, recommended: { name: '亿达信息技术有限公司', sources: ['brand_map'] }, confidence: 'high', candidates: [{ name: '亿达信息技术有限公司', score: 23, sources: ['brand_map', 'baidu'] }, { name: '亿达科技', score: 8 }] },
    enterprise_basic: { fields: { '法定代表人': '张三', '注册资本': '1000万', '成立时间': '2015-03-01' }, tags: ['存续', '高新技术企业'] },
    manual_required: [{ item: '社保缴纳', what_to_check: '面试时确认是否全额缴纳', url: 'https://www.gsxt.gov.cn' }, { item: '社保缴纳', what_to_check: '重复项' }],
    official_checklist: [{ item: '经营异常', what_to_check: '国家企业信用信息公示系统查询' }],
  },
  signals: [{ keyword: '拖欠工资', category: '劳动', severity: 'severe', n_hits: 3, strong_hits: [{ title: '某员工称亿达信息拖欠工资', url: 'https://example.com/a' }], unattributed_hits: [], blocked: false }],
  news: { items: [] },
  reviews: { entries: [{ platform: '脉脉', title: '亿达信息怎么样', url: 'https://maimai.cn/x' }] },
  red_lines: [{ id: 1, name: '拖欠工资', status: 'hit', evidence: [{ title: '某员工称亿达信息拖欠工资', url: 'https://example.com/a' }] }, { id: 2, name: '失信被执行', status: 'unverified', evidence: [] }],
  score: { points: 45, light: 'red', summary: '存在严重劳动纠纷信号', reasons: ['拖欠工资 3 条强信号'] },
  pitfalls: [{ risk: '可能拖欠工资', keyword: '拖欠工资', category: '劳动', evidence: [{ title: '某员工称亿达信息拖欠工资', url: 'https://example.com/a' }] }],
  interview_questions: ['工资发放日期是否固定？', '社保公积金缴纳基数？'],
  meta: { generator: 'intel-compass', time: '2026-10-02 10:00:00', duration: 42.1, cache_hit: false, engines: null, errors: [] },
}

describe('IntelCompassClient', () => {
  it('research 构造 /api/run 请求并归一化为九段报告', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: '/api/run', body: { ok: true, report: rawReport } }])
    const c = new IntelCompassClient({ baseUrl: 'http://127.0.0.1:8765', fetch: fetchImpl })
    const r = await c.research('亿达信息', { engines: ['baidu', 'bing'], skipCache: true })
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8765/api/run', method: 'POST', body: { name: '亿达信息', jurisdiction: 'CN', engines: ['baidu', 'bing'], skip_cache: true, include_reviews: true, save_html: false } })
    expect(r.summary).toEqual({ points: 45, light: 'red', verdict: '存在严重劳动纠纷信号', reasons: ['拖欠工资 3 条强信号'] })
    expect(r.entity.recommended).toBe('亿达信息技术有限公司')
    expect(r.entity.candidates).toHaveLength(2)
    expect(r.business).toMatchObject({ legal_representative: '张三', registered_capital: '1000万', founded: '2015-03-01', tags: ['存续', '高新技术企业'] })
    expect(r.red_lines[0]).toMatchObject({ id: '1', status: 'hit' })
    expect(r.signals[0]).toMatchObject({ keyword: '拖欠工资', hits: 3, strong_hits: [{ url: 'https://example.com/a' }] })
    expect(r.reviews[0].platform).toBe('脉脉')
    expect(r.pitfalls[0].risk).toBe('可能拖欠工资')
    expect(r.interview_questions).toHaveLength(2)
    expect(r.manual_checks.map(m => m.item)).toEqual(['社保缴纳', '经营异常']) // 去重 + 合并 official_checklist
  })

  it('ok:false 抛出带错误信息的异常；health 走 /api/health', async () => {
    const { fetchImpl } = fakeFetch([{ match: '/api/run', body: { ok: false, error: 'TimeoutError: baidu' } }, { match: '/api/health', body: { ok: true, skill: 'intel-compass', l1: true, l2: false, l3: false } }])
    const c = new IntelCompassClient({ baseUrl: 'http://127.0.0.1:8765', fetch: fetchImpl })
    await expect(c.research('x')).rejects.toThrow('TimeoutError: baidu')
    await expect(c.research('   ')).rejects.toThrow('公司名不能为空')
    expect(await c.isAlive()).toBe(true)
  })

  it('normalizeDdReport 容忍缺失段落', () => {
    const r = normalizeDdReport({ company: 'X', score: { points: 70, light: 'weird', summary: '', reasons: [] } })
    expect(r.summary.light).toBe('yellow')
    expect(r.business).toBeNull()
    expect(r.red_lines).toEqual([])
    expect(r.manual_checks).toEqual([])
  })
})

describe('saveReport → company 表', () => {
  it('写入 dd_report_json / traffic_light / manual_checks，并关联同名岗位', () => {
    const repos = memRepos()
    const job = repos.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '后端', company_name: '亿达信息' })
    const report = normalizeDdReport(rawReport)
    const row = saveReport(repos, '亿达信息', report)
    expect(row.traffic_light).toBe('red')
    expect(row.legal_name).toBe('亿达信息技术有限公司')
    expect(JSON.parse(row.brand_names)).toContain('亿达信息')
    expect(JSON.parse(row.manual_checks)).toHaveLength(2)
    const saved = JSON.parse(row.dd_report_json!)
    expect(saved.summary.points).toBe(45)
    expect(saved.raw).toBeUndefined()
    expect(repos.getJob(job.id)?.company_id).toBe(row.id)
    // 再保存一次：更新同一行而不是新建
    const again = saveReport(repos, '亿达信息', { ...report, summary: { ...report.summary, light: 'yellow' } })
    expect(again.id).toBe(row.id)
    expect(again.traffic_light).toBe('yellow')
    expect(repos.db.all('SELECT id FROM company')).toHaveLength(1)
    expect(loadReport(repos, '亿达信息')?.summary.light).toBe('yellow')
  })
})

describe('intelCompassCommand', () => {
  it('python -m web.app，DD_BRAND_MAP 指向模块根目录 brand_map.json', () => {
    const c = intelCompassCommand({ env: { INTEL_COMPASS_DIR: '/m/intel-compass', INTEL_COMPASS_BASE_URL: 'http://127.0.0.1:8777', PYTHON_BIN: 'python3.12' } })
    expect(c).toMatchObject({ command: 'python3.12', args: ['-m', 'web.app', '--host', '127.0.0.1', '--port', '8777'], cwd: '/m/intel-compass', baseUrl: 'http://127.0.0.1:8777' })
    expect(c.env.DD_BRAND_MAP).toBe('/m/intel-compass/brand_map.json')
    expect(intelCompassCommand({ env: { DD_BRAND_MAP: '/custom.json' } }).env.DD_BRAND_MAP).toBe('/custom.json')
    expect(intelCompassCommand({ env: {} }).cwd).toMatch(/modules\/intel-compass$/)
  })
})
