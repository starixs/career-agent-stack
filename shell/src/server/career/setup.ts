/**
 * 求职助理的外部依赖：内置模型 Key 与联网搜索。
 * 用户不能自己配 Key（2026-11-05 定）：只认构建期注入的常量，开发态读同名环境变量；以后改为账号认证后由我们的服务下发。
 * 一个 DeepSeek 模型 Key 同时管模型和搜索（2026-11-05 定）：明确内置过博查 / Tavily / Serper Key 的仍然优先，
 * 没有就用模型 Key 走 DeepSeek 搜索（{模型地址的 origin}/v1/tools/search，CAREER_SEARCH_BASE_URL 可覆盖）。
 * 模型 Key 的实际解析在 admin-config.resolveProviderEnv，这里只做状态汇总；搜索在这里解析，供 search.ts 使用。
 * 只回状态，永远不把 Key 回给渲染层或模型。
 */
import { CAREER_SEARCH_PROVIDERS, getCareerBuildConstants, type CareerSearchProviderName } from '../../shared/career-build-constants';

export type KeySource = 'build' | 'none';

const isProvider = (v: unknown): v is CareerSearchProviderName => typeof v === 'string' && (CAREER_SEARCH_PROVIDERS as readonly string[]).includes(v);

/** 搜索实际用哪家：明确内置的三家之一，或用模型 Key 的 DeepSeek。 */
export type CareerSearchProvider = CareerSearchProviderName | 'deepseek';
export interface CareerSearchConfig { provider: CareerSearchProvider | null; apiKey: string; source: KeySource; /** 只有 DeepSeek 兜底时给：搜索接口的地址（不含 /v1/tools/search） */ baseUrl?: string }

/** 内置模型 Key（构建常量 / 开发态同名环境变量；和 admin-config.resolveProviderEnv 同一口径）。 */
export function resolveCareerLlmKey(): { apiKey: string; source: KeySource } {
  const build = getCareerBuildConstants().llmApiKey;
  return build ? { apiKey: build, source: 'build' } : { apiKey: '', source: 'none' };
}

/**
 * DeepSeek 搜索地址：显式覆盖（CAREER_SEARCH_BASE_URL）优先；否则取模型地址的 origin——
 * https://api.deepseek.com/anthropic → https://api.deepseek.com；自建网关同理取网关的 origin（网关须转发 /v1/tools/search）。
 */
export function deepSeekSearchBaseUrl(llmBaseUrl: string, override = ''): string | undefined {
  if (override.trim()) return override.trim().replace(/\/+$/, '');
  try { return new URL(llmBaseUrl).origin; } catch (error) {
    // undefined = 用 @career/bridges DeepSeekSearch 的官方缺省地址
    console.warn(`[career] search: 模型地址不是合法 URL（${llmBaseUrl}），搜索改用 DeepSeek 官方地址`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 明确内置过的三家之一；没有返回 null。 */
function explicitSearchConfig(): CareerSearchConfig | null {
  const c = getCareerBuildConstants();
  if (c.searchApiKey) return { provider: isProvider(c.searchProvider) ? c.searchProvider : null, apiKey: c.searchApiKey, source: 'build' };
  return null;
}

export function resolveCareerSearchConfig(): CareerSearchConfig {
  const explicit = explicitSearchConfig();
  if (explicit) return explicit;
  const llm = resolveCareerLlmKey();
  if (!llm.apiKey) return { provider: null, apiKey: '', source: 'none' };
  const c = getCareerBuildConstants();
  const baseUrl = deepSeekSearchBaseUrl(c.llmBaseUrl, c.searchBaseUrl);
  return { provider: 'deepseek', apiKey: llm.apiKey, source: llm.source, ...(baseUrl ? { baseUrl } : {}) };
}

export interface CareerSetupStatus {
  llm: { configured: boolean; source: KeySource };
  search: { configured: boolean; source: KeySource; provider: CareerSearchProvider | null };
}

/** bridges 自己认的搜索环境变量（BOCHA_API_KEY 等）：开发机上设了也算配过。 */
const hasEnvSearchKey = (env: NodeJS.ProcessEnv) => !!(env.SEARCH_API_KEY || env.BOCHA_API_KEY || env.TAVILY_API_KEY || env.SERPER_API_KEY || env.DEEPSEEK_API_KEY);

/** 模型 Key 在，搜索就算配好了（DeepSeek 同一个 Key）。 */
export function careerSetupStatus(env: NodeJS.ProcessEnv = process.env): CareerSetupStatus {
  const llm = resolveCareerLlmKey();
  const search = resolveCareerSearchConfig();
  const envSearch = search.source === 'none' && hasEnvSearchKey(env);
  return {
    llm: { configured: llm.source !== 'none', source: llm.source },
    search: { configured: search.source !== 'none' || envSearch, source: envSearch ? 'build' : search.source, provider: search.provider },
  };
}

export const SEARCH_NOT_CONFIGURED_MESSAGE = '联网搜索暂时不可用，这次只能靠模型已有的知识回答；请提醒用户结果需要核实。';
