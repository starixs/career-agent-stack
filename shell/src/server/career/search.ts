/**
 * Web Search 提供方：LLM 唯一允许的外部动作。优先用用户在设置页 / 对话卡片保存的 Key（setup.ts），其次构建常量
 * （CAREER_SEARCH_API_KEY / CAREER_SEARCH_PROVIDER），再其次 @career/bridges 认的环境变量
 * （SEARCH_PROVIDER / SEARCH_API_KEY / BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY / DEEPSEEK_API_KEY）；
 * 都没有就用模型 Key 走 DeepSeek 搜索（零配置：一个 DeepSeek Key 管模型和搜索）。
 */
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
  if (cfg.source === 'settings') {
    // 用户在产品里保存的配置覆盖一切环境变量
    return { ...env, SEARCH_PROVIDER: cfg.provider ?? 'bocha', SEARCH_API_KEY: cfg.apiKey };
  }
  return { ...env, SEARCH_PROVIDER: env.SEARCH_PROVIDER || cfg.provider || undefined, SEARCH_API_KEY: env.SEARCH_API_KEY || cfg.apiKey };
}

/** 返回可用的搜索提供方；连模型 Key 都没有返回 null；领域库未就绪抛 DomainUnavailableError。 */
export async function getSearchProvider(): Promise<CareerSearchProvider | null> {
  if (override !== undefined) return override;
  const bridges = await loadBridges();
  const provider = bridges.tryCreateSearchProvider(searchEnvFor(resolveCareerSearchConfig(), process.env));
  if (provider) console.log(`[career] search provider=${provider.name}`);
  return provider;
}

/** 测试注入：null = 明确不可用。 */
export function setSearchProvider(p: CareerSearchProvider | null | undefined): void {
  override = p;
}
