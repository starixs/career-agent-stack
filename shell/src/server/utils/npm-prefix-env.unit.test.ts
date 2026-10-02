import { describe, expect, it } from 'vitest';

import {
  getkeystoneNpmGlobalBinDir,
  getkeystoneNpmGlobalPrefix,
  scrubkeystoneNpmPrefixEnv,
} from './npm-prefix-env';

describe('npm prefix env utilities', () => {
  it('builds the keystone npm global prefix and bin dir per platform', () => {
    expect(getkeystoneNpmGlobalPrefix('/Users/tester', 'darwin')).toBe('/Users/tester/.keystone/npm-global');
    expect(getkeystoneNpmGlobalBinDir('/Users/tester', 'darwin')).toBe('/Users/tester/.keystone/npm-global/bin');

    expect(getkeystoneNpmGlobalPrefix('C:\\Users\\tester', 'win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.keystone[/\\]npm-global/);
    expect(getkeystoneNpmGlobalBinDir('C:\\Users\\tester', 'win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.keystone[/\\]npm-global/);
  });

  it('scrubs only npm prefix variables that point at the keystone prefix', () => {
    const prefix = '/Users/tester/.keystone/npm-global';
    const env: NodeJS.ProcessEnv = {
      npm_config_prefix: `${prefix}/`,
      NPM_CONFIG_PREFIX: '/Users/tester/.npm-global',
      PREFIX: prefix,
    };

    scrubkeystoneNpmPrefixEnv(env, prefix, 'darwin');

    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBe('/Users/tester/.npm-global');
    expect(env.PREFIX).toBeUndefined();
  });
});
