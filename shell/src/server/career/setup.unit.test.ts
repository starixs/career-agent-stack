import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { careerSetupStatus, resolveCareerSearchConfig } from './setup';

// 用户不能自己配 Key：只认构建常量 / 同名环境变量；状态接口只回"是否配置 + 来源"。

const ENV_KEYS = ['CAREER_LLM_API_KEY', 'CAREER_SEARCH_API_KEY', 'CAREER_SEARCH_PROVIDER'] as const;

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
});
