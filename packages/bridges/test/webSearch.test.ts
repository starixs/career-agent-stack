import { describe, it, expect } from 'vitest'
import { BochaSearch, TavilySearch, SerperSearch, DeepSeekSearch, SearchProviderError, createSearchProvider, tryCreateSearchProvider } from '../src/index.js'
import { fakeFetch } from './helpers.js'

describe('SearchProvider 请求构造与结果映射', () => {
  it('BochaSearch：Bearer key，POST /v1/web-search，映射 webPages.value', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: 'api.bochaai.com/v1/web-search', body: { code: 200, data: { webPages: { value: [
      { name: '标题A', url: 'https://a.com', snippet: '片段A', summary: '摘要A', datePublished: '2026-09-01T00:00:00Z' },
      { name: '无链接', url: '', snippet: 'x' },
    ] } } } }])
    const p = new BochaSearch('bk', { fetch: fetchImpl })
    const r = await p.search('求职 骗局', { count: 5, freshness: 'month' })
    expect(calls[0]).toMatchObject({ url: 'https://api.bochaai.com/v1/web-search', method: 'POST', body: { query: '求职 骗局', count: 5, summary: true, freshness: 'oneMonth' } })
    expect(calls[0].headers.authorization).toBe('Bearer bk')
    expect(r).toEqual([{ title: '标题A', url: 'https://a.com', snippet: '摘要A', publishedAt: '2026-09-01T00:00:00Z' }])
  })

  it('BochaSearch：code != 200 抛错', async () => {
    const { fetchImpl } = fakeFetch([{ match: 'bochaai', body: { code: 403, msg: 'Invalid key' } }])
    await expect(new BochaSearch('bad', { fetch: fetchImpl }).search('q')).rejects.toThrow('Invalid key')
  })

  it('TavilySearch：Bearer key，POST /search，映射 results', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: 'api.tavily.com/search', body: { results: [{ title: 'T', url: 'https://t.com', content: '内容', published_date: '2026-08-01' }] } }])
    const r = await new TavilySearch('tk', { fetch: fetchImpl }).search('公司 口碑', { count: 3, freshness: 'week' })
    expect(calls[0]).toMatchObject({ url: 'https://api.tavily.com/search', method: 'POST', body: { query: '公司 口碑', max_results: 3, time_range: 'week' } })
    expect(calls[0].headers.authorization).toBe('Bearer tk')
    expect(r).toEqual([{ title: 'T', url: 'https://t.com', snippet: '内容', publishedAt: '2026-08-01' }])
  })

  it('SerperSearch：X-API-KEY，POST /search，映射 organic', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: 'google.serper.dev/search', body: { organic: [{ title: 'S', link: 'https://s.com', snippet: '片段', date: '3 days ago' }, { title: 'no link' }] } }])
    const r = await new SerperSearch('sk', { fetch: fetchImpl }).search('校招 截止', { count: 7, freshness: 'day' })
    expect(calls[0]).toMatchObject({ url: 'https://google.serper.dev/search', method: 'POST', body: { q: '校招 截止', num: 7, gl: 'cn', hl: 'zh-cn', tbs: 'qdr:d' } })
    expect(calls[0].headers['x-api-key']).toBe('sk')
    expect(r).toEqual([{ title: 'S', url: 'https://s.com', snippet: '片段', publishedAt: '3 days ago' }])
  })

  it('空 key 构造即报错', () => {
    expect(() => new BochaSearch('')).toThrow()
    expect(() => new TavilySearch('')).toThrow()
    expect(() => new SerperSearch('')).toThrow()
  })
})

describe('createSearchProvider 环境变量选择', () => {
  it('SEARCH_PROVIDER + SEARCH_API_KEY', () => {
    expect(createSearchProvider({ SEARCH_PROVIDER: 'bocha', SEARCH_API_KEY: 'k' }).name).toBe('bocha')
    expect(createSearchProvider({ SEARCH_PROVIDER: 'Tavily', SEARCH_API_KEY: 'k' }).name).toBe('tavily')
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper', SEARCH_API_KEY: 'k' }).name).toBe('serper')
  })
  it('专用变量回退；未配置返回 null / 抛错；未知提供方抛错', () => {
    expect(tryCreateSearchProvider({ TAVILY_API_KEY: 'k' })?.name).toBe('tavily')
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper', SERPER_API_KEY: 'k' }).name).toBe('serper')
    expect(tryCreateSearchProvider({})).toBeNull()
    expect(() => createSearchProvider({})).toThrow('未配置搜索提供方')
    expect(() => createSearchProvider({ SEARCH_PROVIDER: 'bocha' })).toThrow('API key')
    expect(() => createSearchProvider({ SEARCH_PROVIDER: 'bing', SEARCH_API_KEY: 'k' })).toThrow('不支持')
  })
})

describe('DeepSeekSearch（默认提供方，和模型共用一个 Key）', () => {
  const NOW = () => new Date('2026-11-05T08:00:00Z')

  it('Bearer key，POST /v1/tools/search；summary 优先当片段，没链接的丢掉，date 映射 publishedAt', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: 'api.deepseek.com/v1/tools/search', body: { results: [
      { title: '甲公司 校招', url: 'https://a.com/x', snippet: '片段', summary: '摘要', content: '', site_name: 'A', site_icon: '', date: '2026-10-01T00:00:00Z', rerank_score: 2.5, authority: 3 },
      { title: '只有片段', url: 'https://b.com', snippet: '片段B', summary: null, date: null },
      { title: '无链接', url: '', snippet: 'x' },
    ] } }])
    const r = await new DeepSeekSearch('dk', { fetch: fetchImpl, now: NOW }).search('甲公司 校招 网申', { count: 5 })
    expect(calls[0]).toMatchObject({ url: 'https://api.deepseek.com/v1/tools/search', method: 'POST', body: { query: '甲公司 校招 网申', count: 5, ori_question: '甲公司 校招 网申', need_content: false } })
    expect(calls[0].headers.authorization).toBe('Bearer dk')
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(r).toEqual([
      { title: '甲公司 校招', url: 'https://a.com/x', snippet: '摘要', publishedAt: '2026-10-01T00:00:00Z' },
      { title: '只有片段', url: 'https://b.com', snippet: '片段B' },
    ])
  })

  it('query 截到 128 字符，freshness 换成 after: 日期保留在末尾；ori_question 是完整问题截到 128；count 夹到 1–50；自定义网关地址', async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: 'gw.example.com/v1/tools/search', body: { results: [] } }])
    const long = '字'.repeat(200)
    await new DeepSeekSearch('dk', { fetch: fetchImpl, baseUrl: 'https://gw.example.com/', now: NOW }).search(long, { count: 99, freshness: 'week' })
    const body = calls[0].body as { query: string; ori_question: string; count: number }
    expect(body.query.length).toBe(128)
    expect(body.query.endsWith(' after:2026-10-29')).toBe(true)
    expect(body.ori_question).toBe('字'.repeat(128))
    expect(body.count).toBe(50)
  })

  it('错误带上下文：402 余额不足、429 可重试、返回格式不对也报错', async () => {
    const err402 = fakeFetch([{ match: 'deepseek', status: 402, body: { error: { message: 'Insufficient Balance', type: 'payment_required', code: 'insufficient_balance' } } }])
    const e = await new DeepSeekSearch('dk', { fetch: err402.fetchImpl }).search('甲公司').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SearchProviderError)
    expect(e).toMatchObject({ status: 402, retryable: false, provider: 'deepseek' })
    expect((e as Error).message).toContain('账户余额不足')
    expect((e as Error).message).toContain('Insufficient Balance')
    expect((e as Error).message).toContain('甲公司')

    const err429 = fakeFetch([{ match: 'deepseek', status: 429, body: { error: { message: 'Rate limit' } } }])
    await expect(new DeepSeekSearch('dk', { fetch: err429.fetchImpl }).search('q')).rejects.toMatchObject({ status: 429, retryable: true })
    const err503 = fakeFetch([{ match: 'deepseek', status: 503, body: 'upstream down' }])
    await expect(new DeepSeekSearch('dk', { fetch: err503.fetchImpl }).search('q')).rejects.toMatchObject({ status: 503, retryable: true })

    const bad = fakeFetch([{ match: 'deepseek', body: { data: [] } }])
    await expect(new DeepSeekSearch('dk', { fetch: bad.fetchImpl }).search('q')).rejects.toThrow('格式不对')
    expect(() => new DeepSeekSearch('')).toThrow()
  })

  it('环境变量：SEARCH_PROVIDER=deepseek 用 SEARCH_API_KEY 或 DEEPSEEK_API_KEY；只有 DEEPSEEK_API_KEY 时自动选它；老的专用 Key 仍优先；SEARCH_BASE_URL 覆盖地址', async () => {
    expect(createSearchProvider({ SEARCH_PROVIDER: 'deepseek', SEARCH_API_KEY: 'k' }).name).toBe('deepseek')
    expect(createSearchProvider({ SEARCH_PROVIDER: 'DeepSeek', DEEPSEEK_API_KEY: 'k' }).name).toBe('deepseek')
    expect(tryCreateSearchProvider({ DEEPSEEK_API_KEY: 'k' })?.name).toBe('deepseek')
    expect(tryCreateSearchProvider({ DEEPSEEK_API_KEY: 'k', BOCHA_API_KEY: 'b' })?.name).toBe('bocha')
    const { fetchImpl, calls } = fakeFetch([{ match: 'gw.test', body: { results: [] } }])
    await tryCreateSearchProvider({ SEARCH_PROVIDER: 'deepseek', SEARCH_API_KEY: 'k', SEARCH_BASE_URL: 'https://gw.test' }, { fetch: fetchImpl })!.search('q')
    expect(calls[0].url).toBe('https://gw.test/v1/tools/search')
  })
})
