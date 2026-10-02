/**
 * trident-scanner 桥接：BOSS/智联/51job/猎聘 采集 + AI 评分的 Python 模块。
 * 只通过本地 HTTP（bottle，默认 127.0.0.1:8686）或子进程调用，不改其源码。
 *
 * ── 它的 HTTP 路由（web/server.py）──────────────────────────────────────
 *   GET  /api/health                         {status:'ok', version}
 *   GET  /api/funnel | /api/stats | /api/activity?days=7 | /api/workbench | /api/history
 *   GET  /api/jobs?deleted=active|only|all&limit=1..500&offset=0   → Job[]，响应头 X-Total-Count
 *   GET  /api/jobs/search?min_score&salary_min&salary_max&...       → 带筛选的岗位列表
 *   GET  /api/jobs/<id>                      单个岗位
 *   GET  /api/jobs/<id>/score-trace          {job_id, state: available|unavailable|prefilter_only|failed|legacy_missing, trace?}
 *   POST /api/jobs/<id>/mark-resume-sent     标记定制简历已发送
 *   POST /api/jobs/manual-sent               {job_ids:[], confirmed:true}  仅智联/51job/猎聘，手动回填"已投递"
 *   POST /api/jobs/status                    {job_ids:[], status}
 *   POST /api/jobs/soft-delete | restore | permanent-delete | export
 *   POST /api/workbench/task                 {mode: collect|full|score|monitor..., options}  启动后台任务
 *   POST /api/workbench/task/<id>/stop
 *   POST /api/workbench/greetings | deliver | reject   （发送相关，产品里由用户在待审核队列批准后才会调用）
 *   GET  /api/collection/runs | /api/collection/runs/<id>
 *   POST /api/scoring/preview | /api/scoring/start {scope, limit, force_rescore, force}
 *   GET  /api/scoring/runs ; POST /api/scoring/runs/<id>/pause|resume|end
 *   GET  /api/agent/state                    无凭据的状态快照（含当前任务）
 *   GET  /api/agent/tools ; /api/agent/onboarding
 *   GET  /api/agent/evaluations/pending?limit=1..10&include_resume=true   待本地 Agent 评分的岗位
 *   POST /api/agent/evaluations              {evaluations:[{job_id, score, greeting?}]}  回填结构化评分
 *   POST /api/agent/tasks                    {mode: collect|monitor|full, confirm:true}  Agent 安全入口
 *   POST /api/agent/config/preview | apply   只允许改偏好（关键词/城市/薪资…），不碰凭据
 *   GET/POST /api/config ; GET /api/config/schema ; /api/cities ; /api/resume ...
 *
 * ── CLI 子命令（main.py，入口 `trident-scanner [--config config.yaml]`）────
 *   connect | ai-status | scrape [-k 关键词] [-l 上限] | score [--rescore-filtered] | greet | confirm |
 *   send [--force] | status [--full] | run | resume [--job-id] | monitor [--once] [--interval 分钟] |
 *   web [-p 8686] [--no-open]
 */
import { z } from 'zod'
import type { Repos, Job } from '@career/core'
import { fetchJson, httpReady, ManagedProcess, moduleDir, envStr, type FetchLike, type ManagedProcessOptions } from './common.js'

export const TRIDENT_DEFAULT_URL = 'http://127.0.0.1:8686'

/** trident 岗位记录（jobs 表序列化结果）。字段宽松，未知字段透传。 */
export const TridentJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string().nullish(),
  salary: z.string().nullish(),
  city: z.string().nullish(),
  experience: z.string().nullish(),
  education: z.string().nullish(),
  recruitment_type: z.string().nullish(),
  jd: z.string().nullish(),
  hr_name: z.string().nullish(),
  hr_title: z.string().nullish(),
  hr_active: z.string().nullish(),
  company_size: z.string().nullish(),
  company_industry: z.string().nullish(),
  url: z.string().nullish(),
  score: z.number().nullish(),
  score_reason: z.string().nullish(),
  greeting: z.string().nullish(),
  status: z.string().nullish(),
  source_platform: z.string().nullish(),
  source_job_id: z.string().nullish(),
  deleted_at: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
}).passthrough()
export type TridentJob = z.infer<typeof TridentJobSchema>

export interface TridentTask { id: string; mode?: string; label?: string; status?: string; [k: string]: unknown }
export interface TridentState { api_version: string; task: TridentTask | null; last_task: TridentTask | null; preferences?: Record<string, unknown>; ai?: { configured: boolean }; capabilities?: Record<string, boolean> }
export interface TridentScoreTrace { job_id: string; state: 'available' | 'unavailable' | 'prefilter_only' | 'failed' | 'legacy_missing'; trace?: unknown }
export interface TridentEvaluation { job_id: string; score: unknown; greeting?: string }

export interface TridentClientOptions { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number }

export class TridentClient {
  readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  constructor(opts: TridentClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? envStr('TRIDENT_BASE_URL', TRIDENT_DEFAULT_URL)).replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }
  private url(path: string) { return `${this.baseUrl}${path}` }
  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return fetchJson<T>(this.fetchImpl, this.url(path), { query, timeoutMs: this.timeoutMs })
  }
  private async post<T>(path: string, body: unknown = {}) {
    return fetchJson<T>(this.fetchImpl, this.url(path), { method: 'POST', body, timeoutMs: this.timeoutMs })
  }

  // ── 健康与状态 ──
  async health(): Promise<{ status: string; version?: string }> { return (await this.get<{ status: string; version?: string }>('/api/health')).data }
  async isAlive(): Promise<boolean> { try { return (await this.health()).status === 'ok' } catch { return false } }
  async state(): Promise<TridentState> { return (await this.get<TridentState>('/api/agent/state')).data }
  async funnel(): Promise<Record<string, unknown>> { return (await this.get<Record<string, unknown>>('/api/funnel')).data }
  async stats(): Promise<Record<string, unknown>> { return (await this.get<Record<string, unknown>>('/api/stats')).data }

  // ── 岗位列表 / 详情 ──
  async listJobs(opts: { deleted?: 'active' | 'only' | 'all'; limit?: number; offset?: number } = {}): Promise<{ items: TridentJob[]; total: number }> {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
    const { data, headers } = await this.get<unknown[]>('/api/jobs', { deleted: opts.deleted ?? 'active', limit, offset: opts.offset ?? 0 })
    const items = (Array.isArray(data) ? data : []).map(j => TridentJobSchema.parse(j))
    const total = Number(headers.get('X-Total-Count') ?? items.length)
    return { items, total: Number.isFinite(total) ? total : items.length }
  }
  /** 翻页拉全量（默认最多 2000 条，防止无限循环）。 */
  async listAllJobs(opts: { deleted?: 'active' | 'only' | 'all'; max?: number } = {}): Promise<TridentJob[]> {
    const out: TridentJob[] = []; const max = opts.max ?? 2000
    for (let offset = 0; offset < max; offset += 500) {
      const { items, total } = await this.listJobs({ deleted: opts.deleted, limit: 500, offset })
      out.push(...items)
      if (items.length === 0 || out.length >= total) break
    }
    return out.slice(0, max)
  }
  async searchJobs(params: Record<string, string | number | boolean | undefined>): Promise<{ items: TridentJob[]; total: number }> {
    const { data, headers } = await this.get<unknown>('/api/jobs/search', params)
    const arr = Array.isArray(data) ? data : (data as { items?: unknown[] })?.items ?? []
    const items = arr.map(j => TridentJobSchema.parse(j))
    const total = Number(headers.get('X-Total-Count') ?? (data as { total?: number })?.total ?? items.length)
    return { items, total: Number.isFinite(total) ? total : items.length }
  }
  async getJob(id: string): Promise<TridentJob> { return TridentJobSchema.parse((await this.get<unknown>(`/api/jobs/${encodeURIComponent(id)}`)).data) }

  // ── 评分 ──
  async getScoreTrace(id: string): Promise<TridentScoreTrace> { return (await this.get<TridentScoreTrace>(`/api/jobs/${encodeURIComponent(id)}/score-trace`)).data }
  async scoringRuns(): Promise<unknown[]> { return (await this.get<unknown[]>('/api/scoring/runs')).data }
  async startScoring(opts: { scope?: string; limit?: number; force_rescore?: boolean; force?: boolean } = {}): Promise<{ run: unknown; task: TridentTask }> {
    return (await this.post<{ run: unknown; task: TridentTask }>('/api/scoring/start', opts)).data
  }
  /** 本地 Agent 评分链：取待评分岗位 → 用我们自己的模型打分 → 回填。 */
  async pendingEvaluations(opts: { limit?: number; includeResume?: boolean } = {}): Promise<{ items: unknown[]; preferences?: unknown; resume?: unknown; [k: string]: unknown }> {
    const limit = Math.min(10, Math.max(1, opts.limit ?? 5))
    return (await this.get<{ items: unknown[] }>('/api/agent/evaluations/pending', { limit, include_resume: opts.includeResume ? 'true' : undefined })).data
  }
  async submitEvaluations(evaluations: TridentEvaluation[]): Promise<unknown> {
    if (evaluations.length === 0 || evaluations.length > 10) throw new Error('每次只能提交 1-10 个岗位评估')
    return (await this.post<unknown>('/api/agent/evaluations', { evaluations })).data
  }

  // ── 采集 / 任务 ──
  /** 通过 Agent 安全入口触发采集（collect 不评分；full 会在发送前暂停等人工确认）。 */
  async startCollection(mode: 'collect' | 'monitor' | 'full' = 'collect'): Promise<{ task: TridentTask; checks?: unknown; policy?: unknown }> {
    return (await this.post<{ task: TridentTask }>('/api/agent/tasks', { mode, confirm: true })).data
  }
  /** 工作台通用入口（可带采集选项）。mode: collect | full | score | monitor 等。 */
  async startTask(mode: string, options?: Record<string, unknown>): Promise<TridentTask> {
    return (await this.post<TridentTask>('/api/workbench/task', options ? { mode, options } : { mode })).data
  }
  async stopTask(taskId: string): Promise<unknown> { return (await this.post<unknown>(`/api/workbench/task/${encodeURIComponent(taskId)}/stop`)).data }
  async collectionRuns(limit = 20): Promise<unknown[]> { return (await this.get<unknown[]>('/api/collection/runs', { limit })).data }
  async collectionRun(runId: string): Promise<unknown> { return (await this.get<unknown>(`/api/collection/runs/${encodeURIComponent(runId)}`)).data }
  /** 等待某个任务结束（轮询 /api/agent/state）。 */
  async waitTask(taskId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<TridentTask | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
    while (Date.now() < deadline) {
      const s = await this.state()
      if (!s.task || s.task.id !== taskId) return s.last_task?.id === taskId ? s.last_task : null
      await new Promise(r => setTimeout(r, opts.pollMs ?? 2_000))
    }
    throw new Error(`等待任务 ${taskId} 超时`)
  }

  // ── 回填 ──
  /** 用户在智联/51job/猎聘自己投完后，把"已发送"回填给 trident（BOSS 岗位会被它拒绝）。 */
  async markManualSent(jobIds: string[]): Promise<unknown> { return (await this.post<unknown>('/api/jobs/manual-sent', { job_ids: jobIds, confirmed: true })).data }
  async setJobsStatus(jobIds: string[], status: string): Promise<unknown> { return (await this.post<unknown>('/api/jobs/status', { job_ids: jobIds, status })).data }
  async markResumeSent(jobId: string): Promise<unknown> { return (await this.post<unknown>(`/api/jobs/${encodeURIComponent(jobId)}/mark-resume-sent`)).data }
}

// ── 子进程托管 ──────────────────────────────────────────────────────────

export interface TridentProcessOptions {
  dir?: string
  port?: number
  host?: string
  /** 'uv' → `uv run trident-scanner web`；'python' → `PYTHON_BIN -m trident-scanner.main web`；'custom' → TRIDENT_CMD。 */
  runner?: 'uv' | 'python' | 'custom'
  configPath?: string
  fetch?: FetchLike
  startTimeoutMs?: number
  spawnImpl?: ManagedProcessOptions['spawnImpl']
  onLog?: ManagedProcessOptions['onLog']
  env?: NodeJS.ProcessEnv
}

/** 根据环境变量/选项算出启动命令（纯函数，便于测试）。 */
export function tridentCommand(opts: TridentProcessOptions = {}): { command: string; args: string[]; cwd: string; baseUrl: string } {
  const env = opts.env ?? process.env
  const cwd = opts.dir ?? envStr('TRIDENT_DIR', moduleDir('trident-scanner'), env)
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? Number(new URL(envStr('TRIDENT_BASE_URL', TRIDENT_DEFAULT_URL, env)).port || 8686)
  const runner = opts.runner ?? (env.TRIDENT_CMD ? 'custom' : (envStr('TRIDENT_RUNNER', 'uv', env) as 'uv' | 'python'))
  const tail = ['web', '--port', String(port), '--no-open']
  const cfg = opts.configPath ?? env.TRIDENT_CONFIG
  const cfgArgs = cfg ? ['--config', cfg] : []
  let command: string, args: string[]
  if (runner === 'custom') {
    const parts = (env.TRIDENT_CMD ?? '').trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) throw new Error('TRIDENT_CMD 为空')
    command = parts[0]; args = [...parts.slice(1), ...cfgArgs, ...tail]
  } else if (runner === 'python') {
    command = envStr('PYTHON_BIN', 'python3', env); args = ['-m', 'trident-scanner.main', ...cfgArgs, ...tail]
  } else {
    command = envStr('UV_BIN', 'uv', env); args = ['run', 'trident-scanner', ...cfgArgs, ...tail]
  }
  return { command, args, cwd, baseUrl: `http://${host}:${port}` }
}

export class TridentProcess extends ManagedProcess {
  readonly baseUrl: string
  constructor(opts: TridentProcessOptions = {}) {
    const cmd = tridentCommand(opts)
    const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    super({
      command: cmd.command, args: cmd.args, cwd: cmd.cwd,
      isReady: httpReady(fetchImpl, `${cmd.baseUrl}/api/health`),
      startTimeoutMs: opts.startTimeoutMs ?? 90_000,
      spawnImpl: opts.spawnImpl, onLog: opts.onLog,
    })
    this.baseUrl = cmd.baseUrl
  }
  client(fetchImpl?: FetchLike): TridentClient { return new TridentClient({ baseUrl: this.baseUrl, fetch: fetchImpl }) }
}

// ── 导入 core 的 job 表 ────────────────────────────────────────────────

const PLATFORM_ALIASES: Record<string, string> = { boss: 'boss', zhilian: 'zhilian', '51job': '51job', liepin: 'liepin' }

/** trident JobCandidate → core job 行。score_json 里保留 trident 的评分、原因、状态与追踪。 */
export function mapTridentJob(j: TridentJob, trace?: unknown): Parameters<Repos['upsertJob']>[0] {
  const platform = PLATFORM_ALIASES[(j.source_platform ?? 'boss').toLowerCase()] ?? (j.source_platform ?? 'boss')
  const score_json = JSON.stringify({
    provider: 'trident-scanner',
    trident_id: j.id,
    score: j.score ?? null,
    reason: j.score_reason ?? null,
    status: j.status ?? null,
    greeting: j.greeting ?? null,
    hr: { name: j.hr_name ?? null, title: j.hr_title ?? null, active: j.hr_active ?? null },
    company: { size: j.company_size ?? null, industry: j.company_industry ?? null },
    requirements: { experience: j.experience ?? null, education: j.education ?? null, recruitment_type: j.recruitment_type ?? null },
    trace: trace ?? null,
    updated_at: j.updated_at ?? null,
  })
  return {
    source_platform: platform,
    source_job_id: j.source_job_id || j.id,
    url: j.url ?? null,
    company_name: j.company ?? null,
    title: j.title,
    location: j.city ?? null,
    salary: j.salary ?? null,
    jd_raw: j.jd ?? null,
    score_json,
  }
}

/** 把 trident 岗位写入 core 的 job 表（按 (source_platform, source_job_id) upsert）。 */
export function importJobs(repos: Repos, jobs: TridentJob[], traces: Record<string, unknown> = {}): Job[] {
  const out: Job[] = []
  repos.db.transaction(() => {
    for (const j of jobs) {
      if (j.deleted_at) continue
      out.push(repos.upsertJob(mapTridentJob(j, traces[j.id])))
    }
  })
  return out
}

/** 一步到位：拉全量 → 可选取评分追踪 → 入库。 */
export async function syncTridentJobs(client: TridentClient, repos: Repos, opts: { withTrace?: boolean; max?: number } = {}): Promise<Job[]> {
  const jobs = await client.listAllJobs({ max: opts.max })
  const traces: Record<string, unknown> = {}
  if (opts.withTrace) {
    for (const j of jobs) {
      if (j.score == null) continue
      try { const t = await client.getScoreTrace(j.id); if (t.state === 'available') traces[j.id] = t.trace } catch { /* 单条失败不影响整体 */ }
    }
  }
  return importJobs(repos, jobs, traces)
}
