import { describe, expect, it } from 'vitest';

import { ThemeRegistry } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { careerTheme } from '@/theme/themes/career';

import { buildWidgetCssVars } from './widgetCssVars';

describe('Widget Theme projection', () => {
  it('projects a complete synthetic adapter and leaves no synthetic values after switching to default', () => {
    const registry = new ThemeRegistry([careerTheme, syntheticTheme]);

    const syntheticCss = buildWidgetCssVars(registry.resolve(syntheticTheme.id, 'dark', false));
    expect(syntheticCss).toContain('--widget-text: #ffe8ff;');
    expect(syntheticCss).toContain('--widget-radius-card: 9px;');
    expect(syntheticCss).toContain('color-scheme: dark;');

    const defaultCss = buildWidgetCssVars(registry.resolve('keystone-default', 'light', true));
    expect(defaultCss).toContain('--widget-text: #2a241c;');
    expect(defaultCss).toContain('--widget-radius-card: 10px;');
    expect(defaultCss).toContain('color-scheme: light;');
    expect(defaultCss).not.toContain('synthetic-');
  });
});
