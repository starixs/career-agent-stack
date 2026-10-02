/**
 * Web Search 提供方：LLM 唯一允许的外部动作。key / provider 来自构建常量
 * （CAREER_SEARCH_API_KEY / CAREER_SEARCH_PROVIDER），也接受 @career/bridges 认的环境变量
 * （SEARCH_PROVIDER / SEARCH_API_KEY / BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY）。
 */
import { getCareerBuildConstants } from '../../shared/career-build-constants';
import { loadBridges } from './domain';

export interface SearchHit { title: string; url: string; snippet: string; publishedAt?: string }
export interface CareerSearchProvider { readonly name: string; search(query: string, opts?: { count?: number }): Promise<SearchHit[]> }

let override: CareerSearchProvider | null | undefined;

/** 返回可用的搜索提供方；未配置返回 null；领域库未就绪抛 DomainUnavailableError。 */
export async function getSearchProvider(): Promise<CareerSearchProvider | null> {
  if (override !== undefined) return override;
  const bridges = await loadBridges();
  const c = getCareerBuildConstants();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (c.searchProvider && !env.SEARCH_PROVIDER) env.SEARCH_PROVIDER = c.searchProvider;
  if (c.searchApiKey && !env.SEARCH_API_KEY) env.SEARCH_API_KEY = c.searchApiKey;
  return bridges.tryCreateSearchProvider(env);
}

/** 测试注入：null = 明确不可用。 */
export function setSearchProvider(p: CareerSearchProvider | null | undefined): void {
  override = p;
}
