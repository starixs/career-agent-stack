/**
 * Web Search 提供方：LLM 唯一允许的外部动作。Key 只来自构建常量（用户不能自己配，见 setup.ts）：明确内置的
 * 博查 / Tavily / Serper Key 优先（CAREER_SEARCH_API_KEY / CAREER_SEARCH_PROVIDER），也接受 @career/bridges 认的环境变量
 * （SEARCH_PROVIDER / SEARCH_API_KEY / BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY / DEEPSEEK_API_KEY）；
 * 都没有就用模型 Key 走 DeepSeek 搜索（一个 DeepSeek Key 管模型和搜索）。每次搜索按次计价（meteredSearch）。
 */
import { meterToolUsageInBackground } from './billing-service';
import { loadBridges } from './domain';
import { resolveCareerSearchConfig, type CareerSearchConfig } from './setup';

export interface SearchHit { title: string; url: string; snippet: string; publishedAt?: string }
export interface CareerSearchProvider { readonly name: string; search(query: string, opts?: { count?: number }): Promise<SearchHit[]> }

let override: CareerSearchProvider | null | undefined;

/** 开发机上 bridges 自己认的搜索环境变量（明确配过的，比模型 Key 兜底优先）。 */
const ENV_SEARCH_KEYS = ['SEARCH_PROVIDER', 'SEARCH_API_KEY', 'BOCHA_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'DEEPSEEK_API_KEY'] as const;
const hasEnvSearch = (env: NodeJS.ProcessEnv) => ENV_SEARCH_KEYS.some(k => !!env[k]?.trim());

/** 把解析好的配置翻成 bridges.tryCreateSearchProvider 认的环境变量。 */
export function searchEnvFor(cfg: CareerSearchConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (cfg.source === 'none') return env;
  if (cfg.provider === 'deepseek') {
    // 模型 Key 兜底：环境里明确配过别的搜索就不盖掉它
    if (hasEnvSearch(base)) return env;
    return { ...env, SEARCH_PROVIDER: 'deepseek', SEARCH_API_KEY: cfg.apiKey, ...(cfg.baseUrl ? { SEARCH_BASE_URL: cfg.baseUrl } : {}) };
  }
  return { ...env, SEARCH_PROVIDER: env.SEARCH_PROVIDER || cfg.provider || undefined, SEARCH_API_KEY: env.SEARCH_API_KEY || cfg.apiKey };
}

/** 返回可用的搜索提供方；连模型 Key 都没有返回 null；领域库未就绪抛 DomainUnavailableError。 */
export async function getSearchProvider(): Promise<CareerSearchProvider | null> {
  if (override !== undefined) return override;
  const bridges = await loadBridges();
  const provider = bridges.tryCreateSearchProvider(searchEnvFor(resolveCareerSearchConfig(), process.env));
  if (provider) console.log(`[career] search provider=${provider.name}`);
  return provider ? meteredSearch(provider) : null;
}

/** 每次搜索按次计价（价目 `search:<供应商>`，见 @career/core billing/pricing.ts）；搜失败不记。 */
export function meteredSearch(provider: CareerSearchProvider): CareerSearchProvider {
  return {
    name: provider.name,
    async search(query, opts) {
      const hits = await provider.search(query, opts);
      meterToolUsageInBackground(`search:${provider.name}`);
      return hits;
    },
  };
}

/** 测试注入：null = 明确不可用。 */
export function setSearchProvider(p: CareerSearchProvider | null | undefined): void {
  override = p;
}
