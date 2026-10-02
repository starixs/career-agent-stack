import { describe, it, expect } from 'vitest'
import { BochaSearch, TavilySearch, SerperSearch, createSearchProvider, tryCreateSearchProvider } from '../src/index.js'
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
