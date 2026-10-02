import { describe, expect, it } from 'vitest';

import {
  compileBrowserRuntimeSettings,
  detectSystemChrome,
  HUMAN_LIKE_INIT_SCRIPT,
  resolveBrowserRuntimePolicy,
  type BrowserRuntimePolicy,
} from './runtime-settings';

const policy = (overrides: Partial<BrowserRuntimePolicy> = {}): BrowserRuntimePolicy => ({
  persistentProfile: true,
  systemChrome: true,
  mirrorIdentity: false,
  profileRoot: '/home/tester/.keystone/browser-profile',
  ...overrides,
});

describe('compileBrowserRuntimeSettings (human-like browser)', () => {
  it('launches system Chrome without automation banners and with a Chinese desktop context', () => {
    const compiled = compileBrowserRuntimeSettings('session-a', '/workspace/a', policy());

    expect(compiled.channel).toBe('chrome');
    expect(compiled.launchOptions).toMatchObject({
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      channel: 'chrome',
      ignoreDefaultArgs: ['--enable-automation'],
    });
    expect(compiled.launchOptions).not.toHaveProperty('executablePath');
    expect(compiled.launchOptions.args).toEqual(expect.arrayContaining([
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ]));
    expect(compiled.contextOptions).toMatchObject({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1366, height: 768 },
    });
    expect(compiled.contextOptions).not.toHaveProperty('userAgent');
    expect(compiled.initScript).toBe(HUMAN_LIKE_INIT_SCRIPT);
    expect(compiled.initScript).toContain("'webdriver'");
    expect(compiled.initScript).toContain("['zh-CN', 'zh']");
    expect(compiled.initScript).toContain("'plugins'");
    expect(compiled.initScript).toContain('window.chrome');
    expect(compiled.userDataDir).toBe('/home/tester/.keystone/browser-profile/session-a');
    expect(compiled.connectionConfig.browser).toMatchObject({ isolated: false });
  });

  it('falls back to managed Chromium and an isolated Context when the switch is off', () => {
    const compiled = compileBrowserRuntimeSettings(
      'session-a',
      '/workspace/a',
      policy({ persistentProfile: false, systemChrome: false }),
    );

    expect(compiled.channel).toBe('managed-chromium');
    expect(compiled.launchOptions).not.toHaveProperty('channel');
    expect(compiled.launchOptions.ignoreDefaultArgs).toEqual(['--enable-automation']);
    expect(compiled.userDataDir).toBeNull();
    expect(compiled.connectionConfig.browser).toMatchObject({ isolated: true });
  });

  it('sanitizes the Product Session id inside the profile root', () => {
    expect(
      compileBrowserRuntimeSettings('../evil/../id', '/workspace/a', policy()).userDataDir,
    ).toBe('/home/tester/.keystone/browser-profile/___evil____id');
  });

  it('keeps the compiled launch/context objects independent per call', () => {
    const first = compileBrowserRuntimeSettings('s', '/workspace/a', policy());
    const second = compileBrowserRuntimeSettings('s', '/workspace/a', policy());
    (first.launchOptions.args as string[]).push('--mutated');
    expect(second.launchOptions.args).not.toContain('--mutated');
  });
});

describe('resolveBrowserRuntimePolicy', () => {
  it('defaults to a persistent profile under ~/.keystone and honours the opt-out switches', () => {
    const detected = resolveBrowserRuntimePolicy({ CAREER_BROWSER_CHANNEL: 'chrome' }, '/home/tester', 'linux');
    expect(detected).toEqual({
      persistentProfile: true,
      systemChrome: true,
      mirrorIdentity: false,
      profileRoot: '/home/tester/.keystone/browser-profile',
    });

    expect(resolveBrowserRuntimePolicy({
      CAREER_BROWSER_PERSISTENT: '0',
      CAREER_BROWSER_CHANNEL: 'chromium',
      CAREER_BROWSER_IDENTITY_MIRROR: '1',
    }, '/home/tester', 'linux')).toEqual({
      persistentProfile: false,
      systemChrome: false,
      mirrorIdentity: true,
      profileRoot: '/home/tester/.keystone/browser-profile',
    });
  });

  it('detects Google Chrome from the platform install locations only', () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    };
    expect(detectSystemChrome('darwin', {}, '/Users/tester', exists)).toBe(true);
    expect(detectSystemChrome('linux', {}, '/home/tester', exists)).toBe(false);
    expect(detectSystemChrome('win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Users\\t', exists)).toBe(false);
    expect(seen).toContain('/usr/bin/google-chrome');
    expect(seen.some(path => path.endsWith('chrome.exe'))).toBe(true);
    expect(detectSystemChrome('darwin', {}, '/Users/tester', () => { throw new Error('EACCES'); })).toBe(false);
  });
});
