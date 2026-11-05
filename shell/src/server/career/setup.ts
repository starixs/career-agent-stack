/**
 * 求职助理的外部依赖：内置模型 Key 与搜索 Key。
 * 用户不能自己配 Key（2026-11-05 定）：只认构建期注入的常量，开发态读同名环境变量；以后改为账号认证后由我们的服务下发。
 * 模型 Key 的实际解析在 admin-config.resolveProviderEnv，这里只做状态汇总；搜索 Key 在这里解析，供 search.ts 使用。
 * 只回状态，永远不把 Key 回给渲染层或模型。
 */
import { CAREER_SEARCH_PROVIDERS, getCareerBuildConstants, type CareerSearchProviderName } from '../../shared/career-build-constants';

export type KeySource = 'build' | 'none';

const isProvider = (v: unknown): v is CareerSearchProviderName => typeof v === 'string' && (CAREER_SEARCH_PROVIDERS as readonly string[]).includes(v);

export function resolveCareerSearchConfig(): { provider: CareerSearchProviderName | null; apiKey: string; source: KeySource } {
  const c = getCareerBuildConstants();
  if (c.searchApiKey) return { provider: isProvider(c.searchProvider) ? c.searchProvider : null, apiKey: c.searchApiKey, source: 'build' };
  return { provider: null, apiKey: '', source: 'none' };
}

export interface CareerSetupStatus {
  llm: { configured: boolean; source: KeySource };
  search: { configured: boolean; source: KeySource; provider: CareerSearchProviderName | null };
}

export function careerSetupStatus(env: NodeJS.ProcessEnv = process.env): CareerSetupStatus {
  const llmBuild = !!getCareerBuildConstants().llmApiKey;
  const search = resolveCareerSearchConfig();
  // 也认 @career/bridges 自己读的环境变量（BOCHA_API_KEY 等）
  const envSearch = !!(env.SEARCH_API_KEY || env.BOCHA_API_KEY || env.TAVILY_API_KEY || env.SERPER_API_KEY);
  return {
    llm: { configured: llmBuild, source: llmBuild ? 'build' : 'none' },
    search: { configured: search.source !== 'none' || envSearch, source: search.source !== 'none' || envSearch ? 'build' : 'none', provider: search.provider },
  };
}

export const SEARCH_NOT_CONFIGURED_MESSAGE = '联网搜索暂时不可用，这次只能靠模型已有的知识回答；请提醒用户结果需要核实。';
