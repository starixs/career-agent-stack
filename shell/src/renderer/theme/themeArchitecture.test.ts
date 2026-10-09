import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function rendererSourceFiles(directory = resolve(root, 'src/renderer')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(path);
    if (!/\.(?:ts|tsx|css)$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

describe('Theme architecture guardrails', () => {
  it.each([
    'src/renderer/components/TerminalPanel.tsx',
    'src/renderer/components/MonacoEditor.tsx',
    'src/renderer/components/markdown/MermaidDiagram.tsx',
    'src/renderer/components/markdown/CodeBlock.tsx',
    'src/renderer/components/tools/WidgetRenderer.tsx',
  ])('%s consumes the public Theme runtime and does not infer scheme from DOM mutations', (file) => {
    const contents = source(file);
    expect(contents).toContain("from '@/theme'");
    expect(contents).not.toContain('MutationObserver');
  });

  it('keeps palette ownership out of embedded visual consumers', () => {
    expect(source('src/renderer/components/TerminalPanel.tsx')).not.toMatch(/TERMINAL_(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/MonacoEditor.tsx')).not.toMatch(/(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/markdown/MermaidDiagram.tsx')).not.toMatch(/(LIGHT|DARK)_COLORS/);
    expect(source('src/renderer/components/markdown/CodeBlock.tsx')).not.toContain('oneDark');
  });

  it('keeps the test-only synthetic Theme out of the production registry and entry graph', () => {
    expect(source('src/renderer/theme/registry.ts')).not.toContain('synthetic-test-theme');
    expect(source('src/renderer/theme/index.ts')).not.toContain('syntheticTheme');
  });

  it('keeps the global sidebar structural surface scoped to App Shell chrome', () => {
    const consumers = rendererSourceFiles()
      // Theme definitions may alias message surfaces; UI consumers stay scoped.
      .filter(file => !file.startsWith(`${root}/src/renderer/theme/themes/`))
      .filter(file => source(file.slice(root.length + 1)).includes('var(--rail)'))
      .map(file => file.slice(root.length + 1));

    expect(consumers.sort()).toEqual([
      'src/renderer/components/CustomTitleBar.tsx',
      'src/renderer/components/TabBar.tsx',
      'src/renderer/components/global-sidebar/GlobalSidebar.tsx',
      'src/renderer/features/career-shell/CareerNavShell.tsx',
    ]);
  });

  it('reuses one Theme-owned product wordmark across Launcher, About, and the global sidebar', () => {
    const launcher = source('src/renderer/components/launcher/BrandSection.tsx');
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    const sidebar = source('src/renderer/components/global-sidebar/GlobalSidebar.tsx');
    expect(launcher).toContain('<h1 className="theme-product-wordmark theme-launcher-hero-title">');
    expect(settings).toContain('className="theme-product-wordmark theme-launcher-hero-title cursor-default select-none"');
    expect(sidebar).toContain('className="theme-product-wordmark global-sidebar-copy min-w-0 truncate text-sm font-medium"');
    expect(settings).not.toContain('className="brand-title');
  });

  it('keeps Space inside the app-level Theme scope', () => {
    for (const file of [
      'src/renderer/index.css',
      'src/renderer/pages/Space.tsx',
      'src/renderer/pages/space/SpaceChrome.tsx',
      'src/renderer/components/ui/Popover.tsx',
    ]) {
      const contents = source(file);
      expect(contents).not.toContain('data-ui-theme');
      expect(contents).not.toContain('space-mono');
    }
  });

  it('keeps a complete default visual fallback for unknown pre-React Theme IDs', () => {
    const css = source('src/renderer/theme/themes/career.css');
    expect(css).toContain(":root,\nhtml[data-theme-id='keystone-default']");
    expect(css).toContain('--font-sans:');
    expect(css).toContain('--theme-radius-full:');
    expect(css).toContain("html[data-color-scheme='light']");
    expect(css).toContain("html[data-color-scheme='dark']");
    expect(css.match(/--theme-shadow-2xl:/g)).toHaveLength(2);
  });

  it('keeps Tailwind utility generation bridged to runtime Theme tokens', () => {
    const entry = source('src/renderer/index.css');
    const theme = source('src/renderer/theme/themes/career.css');
    expect(entry).toContain('@theme inline');
    // Font tokens share Tailwind's names, so the bridge must not alias them to themselves.
    expect(entry).not.toMatch(/--font-(?:sans|mono): var\(--font-(?:sans|mono)\)/);
    expect(entry).toContain('--radius-full: var(--theme-radius-full)');
    expect(entry).toContain('--shadow-sm: var(--theme-shadow-sm)');
    expect(entry).toContain('--transition-duration-150: var(--motion-fast)');
    expect(theme).not.toContain('@theme');
  });

  it('keeps action surfaces paired with their Theme-owned foreground tokens', () => {
    const forbiddenPairs = [
      /bg-\[var\(--(?:accent|accent-warm)\)\][^'"`]*\btext-white\b/,
      /\btext-white\b[^'"`]*bg-\[var\(--(?:accent|accent-warm)\)\]/,
      /bg-\[var\(--primary\)\][^'"`]*text-\[var\(--bg\)\]/,
      /bg-\[var\(--ink\)\][^'"`]*text-\[var\(--on-primary\)\]/,
      /background(?:-color)?\s*:\s*var\(--primary\)\s*;[^}]*color\s*:\s*#(?:fff|ffffff)\b/is,
      /background(?:-color)?\s*:\s*var\(--ink\)[^}]*color\s*:\s*var\(--on-primary\)/is,
    ];
    const violations = rendererSourceFiles()
      .filter(file => forbiddenPairs.some(pattern => pattern.test(readFileSync(file, 'utf8'))));
    expect(violations).toEqual([]);

    const unvalidatedAccentHoverViolations = rendererSourceFiles()
      .filter(file => /bg-\[var\(--primary\)\][^'"`]*hover:brightness-/.test(readFileSync(file, 'utf8')));
    expect(unvalidatedAccentHoverViolations).toEqual([]);

    for (const primaryAction of [
      'src/renderer/components/chat-input/SimpleChatInput.tsx',
      'src/renderer/components/task-center/ThoughtInput.tsx',
      'src/renderer/components/task-center/editors/PanelChrome.tsx',
    ]) {
      const contents = source(primaryAction);
      expect(contents).toContain('bg-[var(--primary)]');
      expect(contents).toContain('text-[var(--on-primary)]');
      expect(contents).toContain('hover:bg-[var(--primary-hover)]');
    }

    // Filled status surfaces flip between light and dark schemes, so their
    // foreground must be the Theme-owned --on-primary, never a literal white.
    const statusNames = ['success', 'danger', 'warning', 'info'] as const;
    const statusViolations = rendererSourceFiles()
      .filter(file => {
        const contents = readFileSync(file, 'utf8');
        return statusNames.some(status =>
          new RegExp(`bg-\\[var\\(--${status}\\)\\][^'"\\x60]*\\btext-white\\b`).test(contents)
          || new RegExp(`\\btext-white\\b[^'"\\x60]*bg-\\[var\\(--${status}\\)\\]`).test(contents));
      });
    expect(statusViolations).toEqual([]);

    expect(source('src/renderer/hooks/useChatSearch.ts')).toContain('color: var(--on-primary)');
    expect(source('src/renderer/index.css')).toContain('color: var(--bg)');
    const tip = source('src/renderer/components/Tip.tsx');
    expect(tip).toContain('text-[var(--bg)]/70');
    expect(tip).not.toContain('text-white');
    const floatingBall = source('src/renderer/floating-ball/fb.css');
    expect(floatingBall).toContain('color-mix(in srgb, var(--core-c) 45%, var(--fb-highlight-strong))');
    expect(floatingBall).toContain('background: var(--success);\n  color: var(--on-primary);');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop { background: var(--ink); color: var(--bg); }');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop:hover { background: var(--ink-2); }');
    expect(source('src/renderer/components/SettingsHelperInbox.tsx')).toContain('bg-[var(--ink)]/70 text-[var(--bg)]');
  });

  it('keeps Settings on the disk-first Theme and appearance write paths', () => {
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    expect(settings).toContain('updateConfig({ appearanceMode: mode })');
    // One product Theme: Settings offers appearance mode only, no Theme picker.
    expect(settings).not.toContain('ThemePresetSelect');
    expect(settings).not.toContain("tSettings('about.developer.themeTitle')");
    expect(settings).not.toContain('updateConfig({ theme:');
    expect(settings).not.toContain('colorTheme');
  });

  it('keeps the single product Theme as both default and canonical fallback', () => {
    const sharedTheme = source('src/shared/theme.ts');
    const registry = source('src/renderer/theme/registry.ts');
    expect(sharedTheme).toContain("CANONICAL_THEME_ID = 'keystone-default'");
    expect(sharedTheme).toContain('DEFAULT_THEME_ID = CANONICAL_THEME_ID');
    expect(registry).toContain('new ThemeRegistry([careerTheme])');
    expect(sharedTheme).toContain('themeSelectionExplicit');
    expect(registry).toContain('this.definitions.get(CANONICAL_THEME_ID)');
    expect(source('src/renderer/theme/bootstrap.ts')).toContain('THEME_BOOTSTRAP_VERSION = 2');
  });

  it('keeps retired keystone token names out of renderer sources', () => {
    // specs/CAREER_DESIGN.md §9.1 replaced these names; reintroducing one would
    // silently resolve to nothing because no Theme declares it any more.
    const retired = /var\(--(?:paper-elevated|paper-inset|ink-muted|ink-secondary|ink-subtle|ink-faint|line-strong|line-subtle|hover-bg|accent(?:-warm[a-z0-9-]*|-cool[a-z0-9-]*)?|on-accent|error(?:-bg|-hover|-subtle)?|button-(?:primary|dark|secondary)[a-z-]*|global-sidebar-bg[a-z0-9-]*|message-user-bg[a-z0-9-]*|focus-border|font-body|font-display|font-code|duration-(?:fast|normal|slow)|code-(?:bg|header-bg|text|line-number)|heartbeat[a-z-]*|media-[a-z-]+)\)/;
    const offenders = rendererSourceFiles()
      .filter(file => retired.test(readFileSync(file, 'utf8')))
      .map(file => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
