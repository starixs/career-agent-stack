/**
 * 求职产品的构建期常量（打包时注入，缺省回退到环境变量 / 空串）。
 *
 * 注入点：
 *   - Node 侧车：scripts/esbuild-bundle.mjs 的 `define`
 *   - 前端：vite.config.ts 的 `define`
 * 环境变量（构建机）：CAREER_LLM_API_KEY / CAREER_LLM_BASE_URL / CAREER_LLM_MODEL /
 *   CAREER_SEARCH_API_KEY / CAREER_SEARCH_PROVIDER
 *
 * 开发态（tsx / vitest 没有 define）直接读 process.env 同名变量，前端没有 process 时为空串。
 * 这个模块是 renderer / server 共用的纯逻辑，不要引入任何 Node 专属依赖。
 */

declare const __CAREER_LLM_API_KEY__: string | undefined;
declare const __CAREER_LLM_BASE_URL__: string | undefined;
declare const __CAREER_LLM_MODEL__: string | undefined;
declare const __CAREER_SEARCH_API_KEY__: string | undefined;
declare const __CAREER_SEARCH_PROVIDER__: string | undefined;

/** 内置国内模型的 provider id（用户不可见、不可配置）。 */
export const CAREER_LLM_PROVIDER_ID = 'career-llm';
/** 搜索 Key 存在 config.providerApiKeys 里的键名（与模型 Key 同一处，设置页 / 对话卡片写入）。 */
export const CAREER_SEARCH_KEY_ID = 'career-search';
export const CAREER_SEARCH_PROVIDERS = ['bocha', 'tavily', 'serper'] as const;
export type CareerSearchProviderName = typeof CAREER_SEARCH_PROVIDERS[number];
/** DeepSeek 的 Anthropic 兼容入口；ShellLLM 与 SDK 都在其后拼 `/v1/messages`。 */
export const CAREER_LLM_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
export const CAREER_LLM_DEFAULT_MODEL = 'deepseek-flash'; // 支持图片输入；deepseek-chat 为纯文本

function envFallback(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function pick(injected: string | undefined, envName: string): string {
  if (typeof injected === 'string' && injected.trim()) return injected.trim();
  return envFallback(envName);
}

export interface CareerBuildConstants {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  searchApiKey: string;
  searchProvider: string;
}

/** 每次调用都重新读取，便于测试通过 process.env 覆盖。 */
export function getCareerBuildConstants(): CareerBuildConstants {
  return {
    llmApiKey: pick(typeof __CAREER_LLM_API_KEY__ !== 'undefined' ? __CAREER_LLM_API_KEY__ : undefined, 'CAREER_LLM_API_KEY'),
    llmBaseUrl: pick(typeof __CAREER_LLM_BASE_URL__ !== 'undefined' ? __CAREER_LLM_BASE_URL__ : undefined, 'CAREER_LLM_BASE_URL') || CAREER_LLM_DEFAULT_BASE_URL,
    llmModel: pick(typeof __CAREER_LLM_MODEL__ !== 'undefined' ? __CAREER_LLM_MODEL__ : undefined, 'CAREER_LLM_MODEL') || CAREER_LLM_DEFAULT_MODEL,
    searchApiKey: pick(typeof __CAREER_SEARCH_API_KEY__ !== 'undefined' ? __CAREER_SEARCH_API_KEY__ : undefined, 'CAREER_SEARCH_API_KEY'),
    searchProvider: pick(typeof __CAREER_SEARCH_PROVIDER__ !== 'undefined' ? __CAREER_SEARCH_PROVIDER__ : undefined, 'CAREER_SEARCH_PROVIDER'),
  };
}
