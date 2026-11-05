import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { searchEnvFor } from './search';
import { careerSetupStatus, deepSeekSearchBaseUrl, resolveCareerSearchConfig } from './setup';

// 模型 / 搜索 Key：App 里保存的优先，其次构建常量 / 环境变量；状态接口只回"是否配置 + 来源"。

const ENV_KEYS = ['CAREER_LLM_API_KEY', 'CAREER_LLM_BASE_URL', 'CAREER_SEARCH_API_KEY', 'CAREER_SEARCH_PROVIDER', 'CAREER_SEARCH_BASE_URL'] as const;

describe('career setup', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('什么都没配：模型 / 搜索都是 none', () => {
    expect(careerSetupStatus({}, {})).toEqual({
      llm: { configured: false, source: 'none' },
      search: { configured: false, source: 'none', provider: null },
    });
  });

  it('App 里保存的 Key 优先于环境变量；搜索提供方缺省博查', () => {
    process.env.CAREER_LLM_API_KEY = 'sk-env';
    process.env.CAREER_SEARCH_API_KEY = 'env-search';
    process.env.CAREER_SEARCH_PROVIDER = 'tavily';
    const cfg = { providerApiKeys: { 'career-llm': 'sk-saved', 'career-search': 'saved-search' } };
    expect(careerSetupStatus(cfg, {})).toEqual({
      llm: { configured: true, source: 'settings' },
      search: { configured: true, source: 'settings', provider: 'bocha' },
    });
    expect(resolveCareerSearchConfig({ ...cfg, careerSearchProvider: 'serper' })).toEqual({ provider: 'serper', apiKey: 'saved-search', source: 'settings' });
  });

  it('没保存时回退到启动环境（显示为 build 来源）', () => {
    process.env.CAREER_LLM_API_KEY = 'sk-env';
    process.env.CAREER_SEARCH_API_KEY = 'env-search';
    process.env.CAREER_SEARCH_PROVIDER = 'tavily';
    expect(careerSetupStatus({ providerApiKeys: { 'career-llm': '  ' } }, {})).toEqual({
      llm: { configured: true, source: 'build' },
      search: { configured: true, source: 'build', provider: 'tavily' },
    });
  });

  it('只设了 bridges 认的 BOCHA_API_KEY 也算已配置搜索', () => {
    expect(careerSetupStatus({}, { BOCHA_API_KEY: 'x' }).search).toEqual({ configured: true, source: 'build', provider: null });
  });

  it('一个模型 Key 管模型和搜索：没配搜索 Key 时搜索用 DeepSeek、算已配置（不再出「建议配置搜索 Key」）', () => {
    const cfg = { providerApiKeys: { 'career-llm': 'sk-ds' } };
    expect(careerSetupStatus(cfg, {})).toEqual({
      llm: { configured: true, source: 'settings' },
      search: { configured: true, source: 'settings', provider: 'deepseek' },
    });
    expect(resolveCareerSearchConfig(cfg)).toEqual({ provider: 'deepseek', apiKey: 'sk-ds', source: 'settings', baseUrl: 'https://api.deepseek.com' });
    process.env.CAREER_LLM_API_KEY = 'sk-build';
    expect(resolveCareerSearchConfig({})).toMatchObject({ provider: 'deepseek', apiKey: 'sk-build', source: 'build' });
  });

  it('明确配过的博查 / Tavily / Serper 仍然优先（老用户兼容）', () => {
    const cfg = { providerApiKeys: { 'career-llm': 'sk-ds', 'career-search': 'tv' }, careerSearchProvider: 'tavily' };
    expect(resolveCareerSearchConfig(cfg)).toEqual({ provider: 'tavily', apiKey: 'tv', source: 'settings' });
  });

  it('搜索地址：取模型地址的 origin，自建网关同理；CAREER_SEARCH_BASE_URL 覆盖', () => {
    expect(deepSeekSearchBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com');
    expect(deepSeekSearchBaseUrl('https://gw.corp.cn:8443/llm/anthropic')).toBe('https://gw.corp.cn:8443');
    expect(deepSeekSearchBaseUrl('https://api.deepseek.com/anthropic', 'https://gw.corp.cn/ds/')).toBe('https://gw.corp.cn/ds');
    expect(deepSeekSearchBaseUrl('not a url')).toBeUndefined();
    process.env.CAREER_LLM_BASE_URL = 'https://gw.corp.cn/anthropic';
    expect(resolveCareerSearchConfig({ providerApiKeys: { 'career-llm': 'k' } }).baseUrl).toBe('https://gw.corp.cn');
    process.env.CAREER_SEARCH_BASE_URL = 'https://search.corp.cn';
    expect(resolveCareerSearchConfig({ providerApiKeys: { 'career-llm': 'k' } }).baseUrl).toBe('https://search.corp.cn');
  });

  it('选搜索提供方：DeepSeek 兜底时交给 bridges 的环境；开发机上明确配过的搜索环境变量不被盖掉；产品里保存的覆盖环境', () => {
    const ds = { provider: 'deepseek' as const, apiKey: 'sk-ds', source: 'settings' as const, baseUrl: 'https://gw.test' };
    expect(searchEnvFor(ds, {})).toMatchObject({ SEARCH_PROVIDER: 'deepseek', SEARCH_API_KEY: 'sk-ds', SEARCH_BASE_URL: 'https://gw.test' });
    expect(searchEnvFor(ds, { BOCHA_API_KEY: 'b' })).toEqual({ BOCHA_API_KEY: 'b' });
    expect(searchEnvFor({ provider: 'serper', apiKey: 'sp', source: 'settings' }, { SEARCH_PROVIDER: 'bocha', SEARCH_API_KEY: 'x' })).toMatchObject({ SEARCH_PROVIDER: 'serper', SEARCH_API_KEY: 'sp' });
    expect(searchEnvFor({ provider: null, apiKey: '', source: 'none' }, {})).toEqual({});
  });

  it('没搜索时给助理的话不再提博查 / Tavily / Serper', async () => {
    const { SEARCH_NOT_CONFIGURED_MESSAGE } = await import('./setup');
    expect(SEARCH_NOT_CONFIGURED_MESSAGE).not.toMatch(/博查|Tavily|Serper/);
  });
});
