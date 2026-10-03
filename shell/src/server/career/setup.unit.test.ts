import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { careerSetupStatus, resolveCareerSearchConfig } from './setup';

// 模型 / 搜索 Key：App 里保存的优先，其次构建常量 / 环境变量；状态接口只回"是否配置 + 来源"。

const ENV_KEYS = ['CAREER_LLM_API_KEY', 'CAREER_SEARCH_API_KEY', 'CAREER_SEARCH_PROVIDER'] as const;

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
});
