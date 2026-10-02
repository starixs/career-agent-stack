import { describe, it, expect } from 'vitest'
import { TridentClient, importJobs, mapTridentJob, tridentCommand, HttpError, type TridentJob } from '../src/index.js'
import { fakeFetch, memRepos } from './helpers.js'

const job = (over: Partial<TridentJob> = {}): TridentJob => ({
  id: 'boss_123', title: '后端开发工程师', company: '示例科技', salary: '20-30K', city: '上海', experience: '3-5年', education: '本科',
  recruitment_type: 'social', jd: '负责服务端开发', hr_name: '王女士', hr_title: 'HR', company_size: '100-499人', company_industry: '互联网',
  url: 'https://www.zhipin.com/job_detail/123.html', score: 82, score_reason: '技术栈匹配', greeting: null, status: 'scored',
  source_platform: 'boss', source_job_id: '123', created_at: '2026-10-01 10:00:00', updated_at: '2026-10-01 10:00:00', ...over,
})

describe('TridentClient 请求构造与结果映射', () => {
  it('listJobs 带 deleted/limit/offset 查询参数，并从 X-Total-Count 读总数', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: '/api/jobs?', body: [job(), job({ id: 'zl_9', source_platform: 'zhilian', source_job_id: '9' })], headers: { 'X-Total-Count': '42' } }])
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686/', fetch: fetchImpl })
    const r = await c.listJobs({ deleted: 'all', limit: 999, offset: 10 })
    expect(r.total).toBe(42)
    expect(r.items).toHaveLength(2)
    const u = new URL(calls[0].url)
    expect(u.pathname).toBe('/api/jobs')
    expect(u.searchParams.get('deleted')).toBe('all')
    expect(u.searchParams.get('limit')).toBe('500') // 上限 500
    expect(u.searchParams.get('offset')).toBe('10')
    expect(calls[0].method).toBe('GET')
  })

  it('getScoreTrace / health / state 走对应路由', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: '/score-trace', body: { job_id: 'boss_123', state: 'available', trace: { dims: [1, 2] } } },
      { match: '/api/health', body: { status: 'ok', version: '2.4.0' } },
      { match: '/api/agent/state', body: { api_version: 'v1', task: null, last_task: { id: 't1', status: 'done' } } },
    ])
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686', fetch: fetchImpl })
    expect((await c.getScoreTrace('boss_123')).trace).toEqual({ dims: [1, 2] })
    expect(calls[0].url).toBe('http://127.0.0.1:8686/api/jobs/boss_123/score-trace')
    expect((await c.health()).version).toBe('2.4.0')
    expect(await c.isAlive()).toBe(true)
    expect((await c.state()).last_task?.id).toBe('t1')
  })

  it('startCollection 走 Agent 安全入口并带 confirm:true；startTask 走工作台入口', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: '/api/agent/tasks', body: { task: { id: 'task_1', mode: 'collect' }, checks: [] } },
      { match: '/api/workbench/task', body: { id: 'task_2', mode: 'score' } },
    ])
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686', fetch: fetchImpl })
    const r = await c.startCollection('collect')
    expect(r.task.id).toBe('task_1')
    expect(calls[0]).toMatchObject({ method: 'POST', body: { mode: 'collect', confirm: true } })
    expect(calls[0].headers['content-type']).toBe('application/json')
    const t = await c.startTask('score', { scope: 'pending' })
    expect(t.id).toBe('task_2')
    expect(calls[1].body).toEqual({ mode: 'score', options: { scope: 'pending' } })
  })

  it('manual-sent 回填带 confirmed:true；评分回填限制 1-10 条', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: '/api/jobs/manual-sent', body: { updated: ['zl_9'] } },
      { match: '/api/agent/evaluations', body: { accepted: 1 } },
    ])
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686', fetch: fetchImpl })
    await c.markManualSent(['zl_9'])
    expect(calls[0].body).toEqual({ job_ids: ['zl_9'], confirmed: true })
    await c.submitEvaluations([{ job_id: 'boss_123', score: { total: 80 }, greeting: '您好，我有三年后端经验，与岗位要求的技术栈高度匹配，期待沟通。' }])
    expect(calls[1].body).toMatchObject({ evaluations: [{ job_id: 'boss_123' }] })
    await expect(c.submitEvaluations([])).rejects.toThrow('1-10')
  })

  it('非 2xx 抛 HttpError，带状态码与响应体', async () => {
    const { fetchImpl } = fakeFetch([{ match: '/api/jobs/manual-sent', status: 409, body: { error: '存在不允许手动标记的岗位', code: 'manual_sent_conflict' } }])
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686', fetch: fetchImpl })
    const err = await c.markManualSent(['boss_123']).catch(e => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(409)
    expect(err.json()?.code).toBe('manual_sent_conflict')
  })

  it('listAllJobs 按 total 翻页', async () => {
    let n = 0
    const fetchImpl = async (input: string): Promise<Response> => {
      n++
      const offset = Number(new URL(input).searchParams.get('offset'))
      const page = offset === 0 ? Array.from({ length: 500 }, (_, i) => job({ id: `j${i}`, source_job_id: String(i) })) : [job({ id: 'j500', source_job_id: '500' })]
      return new Response(JSON.stringify(page), { status: 200, headers: { 'X-Total-Count': '501' } })
    }
    const c = new TridentClient({ baseUrl: 'http://127.0.0.1:8686', fetch: fetchImpl })
    const all = await c.listAllJobs()
    expect(all).toHaveLength(501)
    expect(n).toBe(2)
  })
})

describe('importJobs → core job 表', () => {
  it('字段映射：source_platform/source_job_id/url/company_name/title/location/salary/jd_raw/score_json', () => {
    const repos = memRepos()
    const rows = importJobs(repos, [job(), job({ id: 'zl_9', source_platform: 'zhilian', source_job_id: '9', company: '智联样例', score: null, score_reason: null }), job({ id: 'gone', deleted_at: '2026-10-01' })])
    expect(rows).toHaveLength(2) // 回收站的跳过
    const j = repos.listJobs().find(x => x.source_job_id === '123')!
    expect(j).toMatchObject({ source_platform: 'boss', url: 'https://www.zhipin.com/job_detail/123.html', company_name: '示例科技', title: '后端开发工程师', location: '上海', salary: '20-30K', jd_raw: '负责服务端开发' })
    const score = JSON.parse(j.score_json!)
    expect(score).toMatchObject({ provider: 'trident-scanner', trident_id: 'boss_123', score: 82, reason: '技术栈匹配', status: 'scored' })
    expect(repos.listJobs().find(x => x.source_platform === 'zhilian')?.company_name).toBe('智联样例')
  })

  it('重复导入按 (platform, job_id) upsert，不产生重复行；无 source_job_id 时用 trident id', () => {
    const repos = memRepos()
    importJobs(repos, [job()])
    importJobs(repos, [job({ score: 90 })])
    expect(repos.listJobs()).toHaveLength(1)
    expect(JSON.parse(repos.listJobs()[0].score_json!).score).toBe(90)
    const m = mapTridentJob(job({ source_job_id: null, source_platform: null }))
    expect(m.source_job_id).toBe('boss_123'); expect(m.source_platform).toBe('boss')
  })
})

describe('tridentCommand（子进程启动命令）', () => {
  it('默认 uv run，端口来自 TRIDENT_BASE_URL，目录来自 TRIDENT_DIR', () => {
    const c = tridentCommand({ env: { TRIDENT_BASE_URL: 'http://127.0.0.1:9000', TRIDENT_DIR: '/tmp/ts' } })
    expect(c).toMatchObject({ command: 'uv', args: ['run', 'trident-scanner', 'web', '--port', '9000', '--no-open'], cwd: '/tmp/ts', baseUrl: 'http://127.0.0.1:9000' })
    expect(tridentCommand({ env: {} }).cwd).toMatch(/modules\/trident-scanner$/)
  })
  it('TRIDENT_RUNNER=python 用 PYTHON_BIN -m；TRIDENT_CMD 完全自定义；--config 透传', () => {
    expect(tridentCommand({ env: { TRIDENT_RUNNER: 'python', PYTHON_BIN: '/opt/py', TRIDENT_CONFIG: '/c.yaml' } })).toMatchObject({ command: '/opt/py', args: ['-m', 'trident-scanner.main', '--config', '/c.yaml', 'web', '--port', '8686', '--no-open'] })
    expect(tridentCommand({ env: { TRIDENT_CMD: '/venv/bin/trident-scanner' }, port: 8700 })).toMatchObject({ command: '/venv/bin/trident-scanner', args: ['web', '--port', '8700', '--no-open'] })
  })
})
