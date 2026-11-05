/**
 * 求职助理的外部依赖配置：一个 DeepSeek 模型 Key 同时管模型和联网搜索（零配置，2026-11-05 定）。
 * 优先级：设置页 / 对话卡片保存到 config.json 的值 > 构建期注入常量 > 环境变量。
 * 模型 Key 的实际解析在 admin-config.resolveProviderEnv（已是"配置优先、常量兜底"），这里只做状态汇总；
 * 搜索在这里解析，供 search.ts 使用：明确配过的博查 / Tavily / Serper Key 仍然优先（老用户兼容），
 * 没配就用模型 Key 走 DeepSeek 搜索（{模型地址的 origin}/v1/tools/search，CAREER_SEARCH_BASE_URL 可覆盖）。
 * 只回状态，永远不把 Key 回给渲染层或模型。
 */
import {
  CAREER_LLM_PROVIDER_ID, CAREER_SEARCH_KEY_ID, CAREER_SEARCH_PROVIDERS, getCareerBuildConstants,
  type CareerSearchProviderName,
} from '../../shared/career-build-constants';
import { loadConfig } from '../utils/admin-config';

export type KeySource = 'settings' | 'build' | 'none';

export interface CareerKeyConfigSlice { providerApiKeys?: Record<string, string>; careerSearchProvider?: string }

function readConfig(): CareerKeyConfigSlice {
  try { return loadConfig() as unknown as CareerKeyConfigSlice; } catch { return {}; }
}

const isProvider = (v: unknown): v is CareerSearchProviderName => typeof v === 'string' && (CAREER_SEARCH_PROVIDERS as readonly string[]).includes(v);

/** 搜索实际用哪家：明确配过的三家之一，或用模型 Key 的 DeepSeek。 */
export type CareerSearchProvider = CareerSearchProviderName | 'deepseek';
export interface CareerSearchConfig { provider: CareerSearchProvider | null; apiKey: string; source: KeySource; /** 只有 DeepSeek 兜底时给：搜索接口的地址（不含 /v1/tools/search） */ baseUrl?: string }

/** 内置模型 Key：设置页保存的优先，其次构建常量（和 admin-config.resolveProviderEnv 同一口径）。 */
export function resolveCareerLlmKey(config: CareerKeyConfigSlice = readConfig()): { apiKey: string; source: KeySource } {
  const saved = config.providerApiKeys?.[CAREER_LLM_PROVIDER_ID]?.trim();
  if (saved) return { apiKey: saved, source: 'settings' };
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

/** 明确配过的三家（设置页 > 构建常量）；没有返回 null。 */
function explicitSearchConfig(config: CareerKeyConfigSlice): CareerSearchConfig | null {
  const saved = config.providerApiKeys?.[CAREER_SEARCH_KEY_ID]?.trim();
  if (saved) return { provider: isProvider(config.careerSearchProvider) ? config.careerSearchProvider : 'bocha', apiKey: saved, source: 'settings' };
  const c = getCareerBuildConstants();
  if (c.searchApiKey) return { provider: isProvider(c.searchProvider) ? c.searchProvider : null, apiKey: c.searchApiKey, source: 'build' };
  return null;
}

export function resolveCareerSearchConfig(config: CareerKeyConfigSlice = readConfig()): CareerSearchConfig {
  const explicit = explicitSearchConfig(config);
  if (explicit) return explicit;
  const llm = resolveCareerLlmKey(config);
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

/** 模型 Key 在，搜索就算配好了（DeepSeek 同一个 Key）；产品不再单独要搜索 Key。 */
export function careerSetupStatus(config: CareerKeyConfigSlice = readConfig(), env: NodeJS.ProcessEnv = process.env): CareerSetupStatus {
  const llm = resolveCareerLlmKey(config);
  const search = resolveCareerSearchConfig(config);
  const envSearch = search.source === 'none' && hasEnvSearchKey(env);
  return {
    llm: { configured: llm.source !== 'none', source: llm.source },
    search: { configured: search.source !== 'none' || envSearch, source: envSearch ? 'build' : search.source, provider: search.provider },
  };
}

export const SEARCH_NOT_CONFIGURED_MESSAGE = '联网搜索暂时用不了：模型 Key 还没配好（搜索和模型共用一个 Key）。请用户在「设置 → 通用 → 求职助理」里填好模型 Key；在那之前公司调研只能靠模型已有知识。';
