import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { searchEnvFor } from './search';
import { careerSetupStatus, deepSeekSearchBaseUrl, resolveCareerSearchConfig } from './setup';

// 用户不能自己配 Key：只认构建常量 / 同名环境变量；状态接口只回"是否配置 + 来源"。

const ENV_KEYS = ['CAREER_LLM_API_KEY', 'CAREER_LLM_BASE_URL', 'CAREER_SEARCH_API_KEY', 'CAREER_SEARCH_PROVIDER', 'CAREER_SEARCH_BASE_URL'] as const;

describe('career setup', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('什么都没注入：模型 / 搜索都是 none', () => {
    expect(careerSetupStatus({})).toEqual({
      llm: { configured: false, source: 'none' },
      search: { configured: false, source: 'none', provider: null },
    });
  });

  it('构建期注入（开发态环境变量）的 Key 生效', () => {
    process.env.CAREER_LLM_API_KEY = 'sk-env';
    process.env.CAREER_SEARCH_API_KEY = 'env-search';
    process.env.CAREER_SEARCH_PROVIDER = 'tavily';
    expect(careerSetupStatus({})).toEqual({
      llm: { configured: true, source: 'build' },
      search: { configured: true, source: 'build', provider: 'tavily' },
    });
    expect(resolveCareerSearchConfig()).toEqual({ provider: 'tavily', apiKey: 'env-search', source: 'build' });
  });

  it('只设了 bridges 认的 BOCHA_API_KEY 也算已配置搜索', () => {
    expect(careerSetupStatus({ BOCHA_API_KEY: 'x' }).search).toEqual({ configured: true, source: 'build', provider: null });
  });

  it('一个模型 Key 管模型和搜索：没注入搜索 Key 时搜索用 DeepSeek、算已配置', () => {
    process.env.CAREER_LLM_API_KEY = 'sk-ds';
    expect(careerSetupStatus({})).toEqual({
      llm: { configured: true, source: 'build' },
      search: { configured: true, source: 'build', provider: 'deepseek' },
    });
    expect(resolveCareerSearchConfig()).toEqual({ provider: 'deepseek', apiKey: 'sk-ds', source: 'build', baseUrl: 'https://api.deepseek.com' });
  });

  it('明确注入过博查 / Tavily / Serper Key 的仍然优先', () => {
    process.env.CAREER_LLM_API_KEY = 'sk-ds';
    process.env.CAREER_SEARCH_API_KEY = 'tv';
    process.env.CAREER_SEARCH_PROVIDER = 'tavily';
    expect(resolveCareerSearchConfig()).toEqual({ provider: 'tavily', apiKey: 'tv', source: 'build' });
  });

  it('搜索地址：取模型地址的 origin，自建网关同理；CAREER_SEARCH_BASE_URL 覆盖', () => {
    expect(deepSeekSearchBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com');
    expect(deepSeekSearchBaseUrl('https://gw.corp.cn:8443/llm/anthropic')).toBe('https://gw.corp.cn:8443');
    expect(deepSeekSearchBaseUrl('https://api.deepseek.com/anthropic', 'https://gw.corp.cn/ds/')).toBe('https://gw.corp.cn/ds');
    expect(deepSeekSearchBaseUrl('not a url')).toBeUndefined();
    process.env.CAREER_LLM_API_KEY = 'k';
    process.env.CAREER_LLM_BASE_URL = 'https://gw.corp.cn/anthropic';
    expect(resolveCareerSearchConfig().baseUrl).toBe('https://gw.corp.cn');
    process.env.CAREER_SEARCH_BASE_URL = 'https://search.corp.cn';
    expect(resolveCareerSearchConfig().baseUrl).toBe('https://search.corp.cn');
  });

  it('选搜索提供方：DeepSeek 兜底时交给 bridges 的环境；开发机上明确配过的搜索环境变量不被盖掉', () => {
    const ds = { provider: 'deepseek' as const, apiKey: 'sk-ds', source: 'build' as const, baseUrl: 'https://gw.test' };
    expect(searchEnvFor(ds, {})).toMatchObject({ SEARCH_PROVIDER: 'deepseek', SEARCH_API_KEY: 'sk-ds', SEARCH_BASE_URL: 'https://gw.test' });
    expect(searchEnvFor(ds, { BOCHA_API_KEY: 'b' })).toEqual({ BOCHA_API_KEY: 'b' });
    expect(searchEnvFor({ provider: 'serper', apiKey: 'sp', source: 'build' }, { SEARCH_PROVIDER: 'bocha', SEARCH_API_KEY: 'x' })).toMatchObject({ SEARCH_PROVIDER: 'bocha', SEARCH_API_KEY: 'x' });
    expect(searchEnvFor({ provider: null, apiKey: '', source: 'none' }, {})).toEqual({});
  });

  it('没搜索时给助理的话不再提博查 / Tavily / Serper', async () => {
    const { SEARCH_NOT_CONFIGURED_MESSAGE } = await import('./setup');
    expect(SEARCH_NOT_CONFIGURED_MESSAGE).not.toMatch(/博查|Tavily|Serper/);
  });
});
