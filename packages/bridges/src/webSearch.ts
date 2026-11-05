/**
 * Web Search 提供方：DeepSeek（默认，和模型共用一个 Key）/ 博查 / Tavily / Serper，统一成 {title,url,snippet,publishedAt?}。
 * LLM 唯一允许的外部动作就是搜索；这里不做任何页面抓取。
 */
import { z } from 'zod'
import { HttpError, fetchJson, type FetchLike } from './common.js'

export interface SearchResult { title: string; url: string; snippet: string; publishedAt?: string }
export interface SearchOptions { count?: number; freshness?: 'day' | 'week' | 'month' | 'year' | 'noLimit'; lang?: string; timeoutMs?: number }
export interface SearchProvider {
  readonly name: string
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
}

export type SearchProviderName = 'bocha' | 'tavily' | 'serper' | 'deepseek'

interface ProviderOptions { fetch?: FetchLike; baseUrl?: string; /** 测试用：固定「现在」（DeepSeek 的 freshness 换算成 after: 日期） */ now?: () => Date }

const clampCount = (n: number | undefined, max: number) => Math.min(max, Math.max(1, n ?? 10))
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** 博查：POST https://api.bochaai.com/v1/web-search，Bearer key。 */
export class BochaSearch implements SearchProvider {
  readonly name = 'bocha'
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  constructor(private readonly apiKey: string, opts: ProviderOptions = {}) {
    if (!apiKey) throw new Error('博查 API key 为空')
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.baseUrl = (opts.baseUrl ?? 'https://api.bochaai.com').replace(/\/+$/, '')
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const freshnessMap: Record<string, string> = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear', noLimit: 'noLimit' }
    const { data } = await fetchJson<{ code?: number; msg?: string; data?: { webPages?: { value?: unknown[] } } }>(this.fetchImpl, `${this.baseUrl}/v1/web-search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: { query, count: clampCount(opts.count, 50), summary: true, freshness: freshnessMap[opts.freshness ?? 'noLimit'] ?? 'noLimit' },
      timeoutMs: opts.timeoutMs,
    })
    if (data?.code !== undefined && data.code !== 200) throw new Error(`博查搜索失败：${data.msg ?? data.code}`)
    const items = data?.data?.webPages?.value ?? []
    return items.map((it) => {
      const o = it as Record<string, unknown>
      return { title: str(o.name), url: str(o.url), snippet: str(o.summary || o.snippet), publishedAt: o.datePublished ? str(o.datePublished) : undefined }
    }).filter(r => r.url)
  }
}

/** Tavily：POST https://api.tavily.com/search，Bearer key（兼容 body.api_key）。 */
export class TavilySearch implements SearchProvider {
  readonly name = 'tavily'
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  constructor(private readonly apiKey: string, opts: ProviderOptions = {}) {
    if (!apiKey) throw new Error('Tavily API key 为空')
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.baseUrl = (opts.baseUrl ?? 'https://api.tavily.com').replace(/\/+$/, '')
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const timeRange: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' }
    const body: Record<string, unknown> = { query, max_results: clampCount(opts.count, 20), search_depth: 'basic', include_answer: false, include_raw_content: false }
    if (opts.freshness && timeRange[opts.freshness]) body.time_range = timeRange[opts.freshness]
    const { data } = await fetchJson<{ results?: unknown[] }>(this.fetchImpl, `${this.baseUrl}/search`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body, timeoutMs: opts.timeoutMs,
    })
    return (data?.results ?? []).map((it) => {
      const o = it as Record<string, unknown>
      return { title: str(o.title), url: str(o.url), snippet: str(o.content), publishedAt: o.published_date ? str(o.published_date) : undefined }
    }).filter(r => r.url)
  }
}

/** Serper（Google）：POST https://google.serper.dev/search，X-API-KEY。 */
export class SerperSearch implements SearchProvider {
  readonly name = 'serper'
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  constructor(private readonly apiKey: string, opts: ProviderOptions = {}) {
    if (!apiKey) throw new Error('Serper API key 为空')
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.baseUrl = (opts.baseUrl ?? 'https://google.serper.dev').replace(/\/+$/, '')
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const tbs: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }
    const body: Record<string, unknown> = { q: query, num: clampCount(opts.count, 100), gl: 'cn', hl: opts.lang ?? 'zh-cn' }
    if (opts.freshness && tbs[opts.freshness]) body.tbs = tbs[opts.freshness]
    const { data } = await fetchJson<{ organic?: unknown[] }>(this.fetchImpl, `${this.baseUrl}/search`, {
      method: 'POST', headers: { 'X-API-KEY': this.apiKey }, body, timeoutMs: opts.timeoutMs,
    })
    return (data?.organic ?? []).map((it) => {
      const o = it as Record<string, unknown>
      return { title: str(o.title), url: str(o.link), snippet: str(o.snippet), publishedAt: o.date ? str(o.date) : undefined }
    }).filter(r => r.url)
  }
}

/** DeepSeek 搜索的 query / ori_question 上限（官方 /v1/tools/search：1–128 字符）。 */
export const DEEPSEEK_SEARCH_MAX_QUERY = 128
/** DeepSeek 一次最多返回几条（官方 count：1–50）。 */
const DEEPSEEK_SEARCH_MAX_COUNT = 50
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DAY_MS = 86_400_000
const FRESHNESS_DAYS: Record<string, number> = { day: 1, week: 7, month: 31, year: 366 }

const DeepSeekSearchResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    snippet: z.string().nullish(),
    summary: z.string().nullish(),
    date: z.string().nullish(),
  }).passthrough()),
}).passthrough()
const DeepSeekErrorSchema = z.object({ error: z.object({ message: z.string().nullish(), type: z.string().nullish(), code: z.union([z.string(), z.number()]).nullish() }) })

/** DeepSeek 搜索失败：status 为 HTTP 状态（解析失败为 0）；retryable = 408 / 429 / 5xx，可以稍后再试。 */
export class SearchProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly status: number, readonly retryable: boolean) {
    super(message)
    this.name = 'SearchProviderError'
  }
}

const DEEPSEEK_STATUS_TEXT: Record<number, string> = { 401: 'Key 无效', 402: '账户余额不足', 429: '请求太频繁' }

function deepSeekHttpError(e: HttpError, query: string): SearchProviderError {
  const parsed = DeepSeekErrorSchema.safeParse(e.json())
  const detail = parsed.success ? parsed.data.error.message ?? parsed.data.error.type ?? '' : e.body.slice(0, 200)
  const label = DEEPSEEK_STATUS_TEXT[e.status] ?? `HTTP ${e.status}`
  const retryable = e.status === 408 || e.status === 429 || e.status >= 500
  return new SearchProviderError(`DeepSeek 搜索失败（${label}）：${detail || '无详情'}；query="${query.slice(0, 40)}"`, 'deepseek', e.status, retryable)
}

/**
 * DeepSeek：POST {base}/v1/tools/search，Bearer <DeepSeek Key>（和模型同一个 Key）。
 * query 最多 128 字符（支持 site: / after: / before:），超了截断；ori_question 放完整问题（同样截到 128）帮它理解意图。
 */
export class DeepSeekSearch implements SearchProvider {
  readonly name = 'deepseek'
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly now: () => Date
  constructor(private readonly apiKey: string, opts: ProviderOptions = {}) {
    if (!apiKey) throw new Error('DeepSeek API key 为空')
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.baseUrl = (opts.baseUrl ?? DEEPSEEK_SEARCH_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.now = opts.now ?? (() => new Date())
  }
  /** freshness 换成 after:YYYY-MM-DD 拼在 query 末尾；总长截到 128，截的是问题本身，日期条件保留。 */
  private queryOf(query: string, freshness: SearchOptions['freshness']): string {
    const days = freshness ? FRESHNESS_DAYS[freshness] : undefined
    const after = days ? ` after:${new Date(this.now().getTime() - days * DAY_MS).toISOString().slice(0, 10)}` : ''
    return query.trim().slice(0, DEEPSEEK_SEARCH_MAX_QUERY - after.length) + after
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const q = this.queryOf(query, opts.freshness)
    const body = { query: q, count: clampCount(opts.count, DEEPSEEK_SEARCH_MAX_COUNT), ori_question: query.trim().slice(0, DEEPSEEK_SEARCH_MAX_QUERY), need_content: false }
    let data: unknown
    try {
      ({ data } = await fetchJson<unknown>(this.fetchImpl, `${this.baseUrl}/v1/tools/search`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body, timeoutMs: opts.timeoutMs,
      }))
    } catch (e) {
      if (e instanceof HttpError) throw deepSeekHttpError(e, q)
      throw e
    }
    const parsed = DeepSeekSearchResponseSchema.safeParse(data)
    if (!parsed.success) throw new SearchProviderError(`DeepSeek 搜索返回的格式不对：${parsed.error.issues[0]?.message ?? '未知'}；query="${q.slice(0, 40)}"`, 'deepseek', 0, false)
    return parsed.data.results.map(o => ({
      title: o.title ?? '', url: o.url ?? '', snippet: o.summary || o.snippet || '', ...(o.date ? { publishedAt: o.date } : {}),
    })).filter(r => r.url)
  }
}

/**
 * 按环境变量选择提供方：SEARCH_PROVIDER=bocha|tavily|serper|deepseek，SEARCH_API_KEY=<key>。
 * 也接受各自的专用变量 BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY / DEEPSEEK_API_KEY（未设 SEARCH_PROVIDER 时按此顺序自动挑第一个有 key 的）。
 * SEARCH_BASE_URL 覆盖所选提供方的地址（如 DeepSeek 走自建网关）；opts.baseUrl 优先。
 */
export function createSearchProvider(env: NodeJS.ProcessEnv = process.env, opts: ProviderOptions = {}): SearchProvider {
  const p = tryCreateSearchProvider(env, opts)
  if (!p) throw new Error('未配置搜索提供方：请设置 SEARCH_PROVIDER（bocha|tavily|serper|deepseek）与 SEARCH_API_KEY')
  return p
}

export function tryCreateSearchProvider(env: NodeJS.ProcessEnv = process.env, opts: ProviderOptions = {}): SearchProvider | null {
  const specific: Record<SearchProviderName, string | undefined> = { bocha: env.BOCHA_API_KEY, tavily: env.TAVILY_API_KEY, serper: env.SERPER_API_KEY, deepseek: env.DEEPSEEK_API_KEY }
  let name = (env.SEARCH_PROVIDER ?? '').trim().toLowerCase() as SearchProviderName | ''
  if (!name) name = (Object.keys(specific) as SearchProviderName[]).find(k => specific[k]) ?? ''
  if (!name) return null
  const key = (env.SEARCH_API_KEY ?? specific[name] ?? '').trim()
  if (!key) throw new Error(`SEARCH_PROVIDER=${name} 但没有 API key（SEARCH_API_KEY 或 ${name.toUpperCase()}_API_KEY）`)
  const base = env.SEARCH_BASE_URL?.trim()
  const withBase: ProviderOptions = { ...opts, ...(opts.baseUrl || !base ? {} : { baseUrl: base }) }
  switch (name) {
    case 'bocha': return new BochaSearch(key, withBase)
    case 'tavily': return new TavilySearch(key, withBase)
    case 'serper': return new SerperSearch(key, withBase)
    case 'deepseek': return new DeepSeekSearch(key, withBase)
    default: throw new Error(`不支持的搜索提供方：${name}（可选 bocha|tavily|serper|deepseek）`)
  }
}
