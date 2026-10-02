/**
 * intel-compass 桥接：公司求职背调（Flask，默认 127.0.0.1:8765）。
 *
 * HTTP（web/app.py）：
 *   POST /api/run   body {name, jurisdiction:'CN'|'US'|..., engines?: string[]|null, rate?: number, skip_cache?, include_reviews?, save_html?}
 *                   → {ok:true, report} | {ok:false, error}
 *   GET  /api/health → {ok, skill:'intel-compass', l1, l2, l3}
 *   GET  /api/download/md|html|json?name=&jurisdiction=&engines=   （html 依赖缺失的模板，产品里不用；json/md 可用）
 * CLI（scripts/data_fetcher.py）：resolve | basic | keyword-sweep | news | reviews | all  <name>
 *   公共参数 --engines baidu,bing --rate-limit 0.3 --timeout 20 --no-cache --json --markdown --outdir；全局 --global-mode --keywords --clear-cache
 *
 * 已知失效点（不改它源码，由本桥接规避）：
 *   1. brand_map.json 默认路径指向 data/brand_map.json（不存在），需设 DD_BRAND_MAP=<模块根>/brand_map.json；
 *   2. HTML 报告模板缺失 → render_html 失败；我们只取 /api/run 的 JSON。
 */
import { z } from 'zod'
import type { Repos, Company } from '@career/core'
import { newId, now } from '@career/core'
import { fetchJson, fetchText, httpReady, ManagedProcess, moduleDir, envStr, type FetchLike, type ManagedProcessOptions } from './common.js'

export const INTEL_COMPASS_DEFAULT_URL = 'http://127.0.0.1:8765'

export type TrafficLight = 'green' | 'yellow' | 'red'

const Link = z.object({ title: z.string().default(''), url: z.string().default('') }).passthrough()
const RawReport = z.object({
  company: z.string(),
  basic: z.object({
    resolve: z.object({ matched: z.boolean().optional(), recommended: z.object({ name: z.string(), sources: z.unknown().optional() }).passthrough().nullish(), confidence: z.unknown().optional(), note: z.string().optional(), candidates: z.array(z.object({ name: z.string(), score: z.unknown().optional(), sources: z.unknown().optional() }).passthrough()).default([]) }).passthrough().default({}),
    enterprise_basic: z.object({ fields: z.record(z.string()).default({}), tags: z.array(z.string()).default([]) }).passthrough().nullish(),
    manual_required: z.array(z.object({ item: z.string(), what_to_check: z.string().optional(), url: z.string().optional() }).passthrough()).default([]),
    official_checklist: z.array(z.object({ item: z.string(), what_to_check: z.string().optional(), url: z.string().optional() }).passthrough()).default([]),
  }).passthrough().default({}),
  signals: z.array(z.object({ keyword: z.string(), category: z.string().default(''), severity: z.string().default(''), n_hits: z.number().default(0), strong_hits: z.array(Link).default([]), unattributed_hits: z.array(z.unknown()).default([]), blocked: z.boolean().optional() }).passthrough()).default([]),
  news: z.unknown().optional(),
  reviews: z.object({ entries: z.array(z.object({ platform: z.string().default(''), title: z.string().default(''), url: z.string().default('') }).passthrough()).default([]) }).passthrough().default({}),
  red_lines: z.array(z.object({ id: z.union([z.string(), z.number()]), name: z.string(), status: z.string(), evidence: z.array(Link).default([]) }).passthrough()).default([]),
  score: z.object({ points: z.number().default(0), light: z.string().default('yellow'), summary: z.string().default(''), reasons: z.array(z.string()).default([]) }).passthrough(),
  pitfalls: z.array(z.object({ risk: z.string(), keyword: z.string().default(''), category: z.string().optional(), evidence: z.array(Link).default([]) }).passthrough()).default([]),
  interview_questions: z.array(z.string()).default([]),
  meta: z.record(z.unknown()).default({}),
}).passthrough()
export type IntelCompassRawReport = z.infer<typeof RawReport>

/** 九段报告（字段名英文，内容中文）。 */
export interface DdReport {
  company: string
  jurisdiction: string
  /** 一、结论速览 */
  summary: { points: number; light: TrafficLight; verdict: string; reasons: string[] }
  /** 二、主体识别（消歧） */
  entity: { matched: boolean; recommended: string | null; confidence: unknown; note: string | null; candidates: Array<{ name: string; score?: unknown; sources?: unknown }> }
  /** 三、基础工商信息 */
  business: { legal_representative: string | null; registered_capital: string | null; founded: string | null; fields: Record<string, string>; tags: string[] } | null
  /** 四、红线核验 */
  red_lines: Array<{ id: string; name: string; status: 'hit' | 'unverified' | 'clean' | string; evidence: Array<{ title: string; url: string }> }>
  /** 五、风险信号扫描 */
  signals: Array<{ keyword: string; category: string; severity: string; hits: number; strong_hits: Array<{ title: string; url: string }>; blocked: boolean }>
  /** 六、员工评价入口 */
  reviews: Array<{ platform: string; title: string; url: string }>
  /** 七、坑点清单 */
  pitfalls: Array<{ risk: string; keyword: string; evidence: Array<{ title: string; url: string }> }>
  /** 八、面试提问清单 */
  interview_questions: string[]
  /** 九、人工核实清单 */
  manual_checks: Array<{ item: string; what_to_check: string; url: string | null }>
  meta: Record<string, unknown>
  raw: IntelCompassRawReport
}

const toLight = (s: string): TrafficLight => (s === 'green' || s === 'red' ? s : 'yellow')

/** 把 data_fetcher.run_all 的原始 JSON 归一化成九段报告。 */
export function normalizeDdReport(rawInput: unknown, jurisdiction = 'CN'): DdReport {
  const raw = RawReport.parse(rawInput)
  const res = raw.basic.resolve
  const eb = raw.basic.enterprise_basic ?? null
  const manual = new Map<string, { item: string; what_to_check: string; url: string | null }>()
  for (const m of [...raw.basic.manual_required, ...raw.basic.official_checklist]) if (!manual.has(m.item)) manual.set(m.item, { item: m.item, what_to_check: m.what_to_check ?? '', url: m.url || null })
  return {
    company: raw.company,
    jurisdiction,
    summary: { points: raw.score.points, light: toLight(raw.score.light), verdict: raw.score.summary, reasons: raw.score.reasons },
    entity: { matched: !!res.matched, recommended: res.recommended?.name ?? null, confidence: res.confidence ?? null, note: res.note ?? null, candidates: res.candidates.map(c => ({ name: c.name, score: c.score, sources: c.sources })) },
    business: eb ? { legal_representative: eb.fields['法定代表人'] ?? null, registered_capital: eb.fields['注册资本'] ?? null, founded: eb.fields['成立时间'] ?? null, fields: eb.fields, tags: eb.tags } : null,
    red_lines: raw.red_lines.map(r => ({ id: String(r.id), name: r.name, status: r.status, evidence: r.evidence.map(e => ({ title: e.title, url: e.url })) })),
    signals: raw.signals.map(s => ({ keyword: s.keyword, category: s.category, severity: s.severity, hits: s.n_hits, strong_hits: s.strong_hits.map(e => ({ title: e.title, url: e.url })), blocked: !!s.blocked })),
    reviews: raw.reviews.entries.map(e => ({ platform: e.platform, title: e.title, url: e.url })),
    pitfalls: raw.pitfalls.map(p => ({ risk: p.risk, keyword: p.keyword, evidence: p.evidence.map(e => ({ title: e.title, url: e.url })) })),
    interview_questions: raw.interview_questions,
    manual_checks: [...manual.values()],
    meta: raw.meta,
    raw,
  }
}

export interface ResearchOptions {
  jurisdiction?: 'CN' | 'US' | 'UK' | 'SG' | 'HK' | 'TW' | 'Other' | string
  engines?: string[] | null
  rate?: number
  skipCache?: boolean
  includeReviews?: boolean
  timeoutMs?: number
}

export interface IntelCompassClientOptions { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number }

export class IntelCompassClient {
  readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  constructor(opts: IntelCompassClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? envStr('INTEL_COMPASS_BASE_URL', INTEL_COMPASS_DEFAULT_URL)).replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000 // 全流程 30-90 秒，留足余量
  }
  async health(): Promise<{ ok: boolean; skill?: string; l1?: boolean; l2?: boolean; l3?: boolean }> {
    return (await fetchJson<{ ok: boolean }>(this.fetchImpl, `${this.baseUrl}/api/health`, { timeoutMs: 5_000 })).data
  }
  async isAlive(): Promise<boolean> { try { return (await this.health()).ok === true } catch { return false } }

  /** 跑全流程并返回九段报告。 */
  async research(companyName: string, opts: ResearchOptions = {}): Promise<DdReport> {
    const name = companyName.trim()
    if (!name) throw new Error('公司名不能为空')
    const jurisdiction = opts.jurisdiction ?? 'CN'
    const body = { name, jurisdiction, engines: opts.engines ?? null, rate: opts.rate ?? 0.3, skip_cache: opts.skipCache ?? false, include_reviews: opts.includeReviews ?? true, save_html: false }
    const { data } = await fetchJson<{ ok: boolean; report?: unknown; error?: string }>(this.fetchImpl, `${this.baseUrl}/api/run`, { method: 'POST', body, timeoutMs: opts.timeoutMs ?? this.timeoutMs })
    if (!data?.ok || !data.report) throw new Error(`intel-compass 背调失败：${data?.error ?? '未知错误'}`)
    return normalizeDdReport(data.report, jurisdiction)
  }
  /** Markdown 版报告（服务端 render_markdown，不依赖 HTML 模板）。 */
  async markdown(companyName: string, jurisdiction = 'CN'): Promise<string> {
    return fetchText(this.fetchImpl, `${this.baseUrl}/api/download/md`, { query: { name: companyName, jurisdiction }, timeoutMs: this.timeoutMs })
  }
}

// ── 子进程托管 ──────────────────────────────────────────────────────────

export interface IntelCompassProcessOptions {
  dir?: string; port?: number; host?: string; pythonBin?: string
  fetch?: FetchLike; startTimeoutMs?: number
  spawnImpl?: ManagedProcessOptions['spawnImpl']; onLog?: ManagedProcessOptions['onLog']; env?: NodeJS.ProcessEnv
}

/** 纯函数：算出启动命令与环境（含 DD_BRAND_MAP 修正）。 */
export function intelCompassCommand(opts: IntelCompassProcessOptions = {}): { command: string; args: string[]; cwd: string; env: Record<string, string>; baseUrl: string } {
  const env = opts.env ?? process.env
  const cwd = opts.dir ?? envStr('INTEL_COMPASS_DIR', moduleDir('intel-compass'), env)
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? Number(new URL(envStr('INTEL_COMPASS_BASE_URL', INTEL_COMPASS_DEFAULT_URL, env)).port || 8765)
  const command = opts.pythonBin ?? envStr('PYTHON_BIN', 'python3', env)
  return {
    command, args: ['-m', 'web.app', '--host', host, '--port', String(port)], cwd,
    env: { DD_BRAND_MAP: envStr('DD_BRAND_MAP', `${cwd}/brand_map.json`, env), PYTHONUNBUFFERED: '1' },
    baseUrl: `http://${host}:${port}`,
  }
}

export class IntelCompassProcess extends ManagedProcess {
  readonly baseUrl: string
  constructor(opts: IntelCompassProcessOptions = {}) {
    const cmd = intelCompassCommand(opts)
    const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    super({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, isReady: httpReady(fetchImpl, `${cmd.baseUrl}/api/health`), startTimeoutMs: opts.startTimeoutMs ?? 60_000, spawnImpl: opts.spawnImpl, onLog: opts.onLog })
    this.baseUrl = cmd.baseUrl
  }
  client(fetchImpl?: FetchLike): IntelCompassClient { return new IntelCompassClient({ baseUrl: this.baseUrl, fetch: fetchImpl }) }
}

// ── 写入 company 表 ─────────────────────────────────────────────────────

/** 按品牌名/法定名找公司行。 */
export function findCompany(repos: Repos, name: string): Company | undefined {
  const rows = repos.db.all<Company>('SELECT * FROM company WHERE legal_name=? OR instr(brand_names, ?) > 0 ORDER BY updated_at DESC', [name, JSON.stringify(name).slice(1, -1)])
  return rows.find(r => r.legal_name === name || (JSON.parse(r.brand_names || '[]') as string[]).includes(name))
}

/** 保存九段报告：dd_report_json / traffic_light / manual_checks，并把同名岗位的 company_id 关联上。 */
export function saveReport(repos: Repos, companyName: string, report: DdReport): Company {
  const t = now()
  const legal = report.entity.recommended ?? report.business?.fields['企业名称'] ?? null
  const existing = findCompany(repos, companyName) ?? (legal ? findCompany(repos, legal) : undefined)
  const brands = new Set<string>(existing ? (JSON.parse(existing.brand_names || '[]') as string[]) : [])
  brands.add(companyName); if (report.company) brands.add(report.company)
  const patch = {
    legal_name: legal ?? existing?.legal_name ?? null,
    brand_names: JSON.stringify([...brands]),
    dd_report_json: JSON.stringify(stripRaw(report)),
    traffic_light: report.summary.light,
    manual_checks: JSON.stringify(report.manual_checks),
    updated_at: t,
  }
  let id: string
  repos.db.transaction(() => {
    if (existing) { id = existing.id; repos.db.update('company', id, patch) }
    else { id = newId('cmp'); repos.db.insert('company', { id, ...patch }) }
    const names = [...brands, ...(legal ? [legal] : [])]
    for (const n of names) repos.db.run('UPDATE job SET company_id=? WHERE company_name=? AND company_id IS NULL', [id, n])
  })
  return repos.db.get<Company>('SELECT * FROM company WHERE id=?', [id!])!
}

function stripRaw(report: DdReport): Omit<DdReport, 'raw'> {
  const { raw: _raw, ...rest } = report
  return rest
}

/** 读取已保存的报告。 */
export function loadReport(repos: Repos, companyName: string): DdReport | undefined {
  const row = findCompany(repos, companyName)
  if (!row?.dd_report_json) return undefined
  return JSON.parse(row.dd_report_json) as DdReport
}
