export type SettingsSection =
  | 'general'
  | 'proxy'
  | 'external-cli'
  | 'shortcuts'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'sub-agents'
  | 'plugins'
  | 'agent'
  | 'usage-stats'
  | 'desktop-pet'
  | 'about';

export const VALID_SECTIONS: SettingsSection[] = [
  'general',
  'proxy',
  'external-cli',
  'shortcuts',
  'providers',
  'mcp',
  'skills',
  'sub-agents',
  'plugins',
  'agent',
  'usage-stats',
  'desktop-pet',
  'about',
];

export const KEYSTONE_GITHUB_URL = 'https://github.com/internal/keystone';
export const KEYSTONE_SOURCE_CODE_URL = KEYSTONE_GITHUB_URL;
export const KEYSTONE_RELEASES_URL = `${KEYSTONE_GITHUB_URL}/releases`;

export const PLAYWRIGHT_DEVICE_PRESETS = [
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone SE',
  'iPad Pro 11',
  'Pixel 7',
  'Galaxy S23',
];
