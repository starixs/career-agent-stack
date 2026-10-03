/**
 * 求职助理的外部依赖配置：模型 Key（必需）与搜索 Key（建议）。
 * 优先级：设置页 / 对话卡片保存到 config.json 的值 > 构建期注入常量 > 环境变量。
 * 模型 Key 的实际解析在 admin-config.resolveProviderEnv（已是"配置优先、常量兜底"），这里只做状态汇总；
 * 搜索 Key 在这里解析，供 search.ts 使用。只回状态，永远不把 Key 回给渲染层或模型。
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

export function resolveCareerSearchConfig(config: CareerKeyConfigSlice = readConfig()): { provider: CareerSearchProviderName | null; apiKey: string; source: KeySource } {
  const saved = config.providerApiKeys?.[CAREER_SEARCH_KEY_ID]?.trim();
  if (saved) return { provider: isProvider(config.careerSearchProvider) ? config.careerSearchProvider : 'bocha', apiKey: saved, source: 'settings' };
  const c = getCareerBuildConstants();
  if (c.searchApiKey) return { provider: isProvider(c.searchProvider) ? c.searchProvider : null, apiKey: c.searchApiKey, source: 'build' };
  return { provider: null, apiKey: '', source: 'none' };
}

export interface CareerSetupStatus {
  llm: { configured: boolean; source: KeySource };
  search: { configured: boolean; source: KeySource; provider: CareerSearchProviderName | null };
}

export function careerSetupStatus(config: CareerKeyConfigSlice = readConfig(), env: NodeJS.ProcessEnv = process.env): CareerSetupStatus {
  const llmSaved = !!config.providerApiKeys?.[CAREER_LLM_PROVIDER_ID]?.trim();
  const llmBuild = !!getCareerBuildConstants().llmApiKey;
  const search = resolveCareerSearchConfig(config);
  // 也认 @career/bridges 自己读的环境变量（BOCHA_API_KEY 等）
  const envSearch = !!(env.SEARCH_API_KEY || env.BOCHA_API_KEY || env.TAVILY_API_KEY || env.SERPER_API_KEY);
  return {
    llm: { configured: llmSaved || llmBuild, source: llmSaved ? 'settings' : llmBuild ? 'build' : 'none' },
    search: {
      configured: search.source !== 'none' || envSearch,
      source: search.source !== 'none' ? search.source : envSearch ? 'build' : 'none',
      provider: search.provider,
    },
  };
}

export const SEARCH_NOT_CONFIGURED_MESSAGE = '搜索还没配置：请用户在对话里的「配置搜索 Key」卡片，或「设置 → 通用 → 求职助理：模型与搜索」里填一个博查 / Tavily / Serper 的 Key。不配置也能用，但公司调研只能靠模型已有知识。';
