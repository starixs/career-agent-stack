/**
 * Web Search 提供方：博查 / Tavily / Serper，统一成 {title,url,snippet,publishedAt?}。
 * LLM 唯一允许的外部动作就是搜索；这里不做任何页面抓取。
 */
import { fetchJson, type FetchLike } from './common.js'

export interface SearchResult { title: string; url: string; snippet: string; publishedAt?: string }
export interface SearchOptions { count?: number; freshness?: 'day' | 'week' | 'month' | 'year' | 'noLimit'; lang?: string; timeoutMs?: number }
export interface SearchProvider {
  readonly name: string
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
}

export type SearchProviderName = 'bocha' | 'tavily' | 'serper'

interface ProviderOptions { fetch?: FetchLike; baseUrl?: string }

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

/**
 * 按环境变量选择提供方：SEARCH_PROVIDER=bocha|tavily|serper，SEARCH_API_KEY=<key>。
 * 也接受各自的专用变量 BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY（未设 SEARCH_PROVIDER 时按此顺序自动挑第一个有 key 的）。
 */
export function createSearchProvider(env: NodeJS.ProcessEnv = process.env, opts: ProviderOptions = {}): SearchProvider {
  const p = tryCreateSearchProvider(env, opts)
  if (!p) throw new Error('未配置搜索提供方：请设置 SEARCH_PROVIDER（bocha|tavily|serper）与 SEARCH_API_KEY')
  return p
}

export function tryCreateSearchProvider(env: NodeJS.ProcessEnv = process.env, opts: ProviderOptions = {}): SearchProvider | null {
  const specific: Record<SearchProviderName, string | undefined> = { bocha: env.BOCHA_API_KEY, tavily: env.TAVILY_API_KEY, serper: env.SERPER_API_KEY }
  let name = (env.SEARCH_PROVIDER ?? '').trim().toLowerCase() as SearchProviderName | ''
  if (!name) name = (Object.keys(specific) as SearchProviderName[]).find(k => specific[k]) ?? ''
  if (!name) return null
  const key = (env.SEARCH_API_KEY ?? specific[name] ?? '').trim()
  if (!key) throw new Error(`SEARCH_PROVIDER=${name} 但没有 API key（SEARCH_API_KEY 或 ${name.toUpperCase()}_API_KEY）`)
  switch (name) {
    case 'bocha': return new BochaSearch(key, opts)
    case 'tavily': return new TavilySearch(key, opts)
    case 'serper': return new SerperSearch(key, opts)
    default: throw new Error(`不支持的搜索提供方：${name}（可选 bocha|tavily|serper）`)
  }
}
