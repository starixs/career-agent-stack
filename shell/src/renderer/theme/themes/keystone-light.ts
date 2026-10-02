import stylesheetText from './keystone-light.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const keystoneLightThemeManifest = {
  id: 'keystone-light',
  displayName: 'keystone Light',
  description: 'Claude-inspired surfaces with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
