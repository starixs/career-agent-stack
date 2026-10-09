/** Leaf contract export avoids a registry -> concrete Theme -> registry cycle.
 *  Token roles are defined in specs/CAREER_DESIGN.md §2–4. */
export const REQUIRED_THEME_CSS_TOKENS = [
  '--font-sans', '--font-human', '--font-mono',
  '--bg', '--rail', '--side', '--paper', '--inset', '--hover', '--selected',
  '--bg-a0', '--rail-a0', '--paper-a0', '--inset-a0',
  '--ink', '--ink-2', '--muted', '--subtle',
  '--line', '--line-2', '--hard',
  '--primary', '--primary-hover', '--primary-soft', '--primary-muted', '--primary-soft-a0', '--on-primary',
  '--seal', '--note', '--note-a0', '--mark', '--mint',
  '--success', '--success-bg', '--warning', '--warning-bg', '--danger', '--danger-bg', '--info', '--info-bg',
  '--toggle-thumb',
  '--fb-surface-peek', '--fb-surface-glass', '--fb-surface-pin', '--fb-surface-pin-a0',
  '--fb-surface-pin-72', '--fb-surface-pin-95', '--fb-glass-border', '--fb-glass-border-soft',
  '--fb-highlight', '--fb-highlight-mid', '--fb-highlight-faint', '--fb-highlight-strong',
  '--fb-highlight-a0', '--fb-highlight-line', '--fb-mask-opaque', '--fb-shadow-strong',
  '--fb-shadow-soft', '--fb-shadow-panel', '--fb-shadow-preview', '--fb-core-shadow',
  '--fb-inset-shadow', '--fb-window-shadow', '--fb-control-hover', '--fb-line-input', '--fb-line-thumb',
  '--fb-drag-handle',
  '--theme-radius-base', '--theme-radius-sm', '--theme-radius-md', '--theme-radius-lg',
  '--theme-radius-xl', '--theme-radius-2xl', '--theme-radius-full',
  '--theme-shadow-base', '--theme-shadow-xs', '--theme-shadow-sm', '--theme-shadow-md',
  '--theme-shadow-lg', '--theme-shadow-xl', '--theme-shadow-2xl', '--theme-shadow-hard',
  '--theme-shadow-hard-lg',
  '--motion-fast', '--motion-base', '--motion-slow',
] as const;

export const REQUIRED_WIDGET_CSS_VARIABLES = [
  '--widget-text', '--widget-text-secondary', '--widget-text-muted',
  '--widget-bg', '--widget-bg-elevated', '--widget-bg-inset',
  '--widget-border', '--widget-border-strong',
  '--widget-accent', '--widget-accent-hover', '--widget-accent-subtle',
  '--widget-success', '--widget-success-bg', '--widget-error', '--widget-error-bg',
  '--widget-warning', '--widget-warning-bg', '--widget-info', '--widget-info-bg',
  '--widget-primary-text', '--widget-font-body', '--widget-radius-track',
  '--widget-radius-control', '--widget-radius-card', '--widget-radius-full',
  '--widget-control-shadow',
] as const;

export type WidgetCssVariable = (typeof REQUIRED_WIDGET_CSS_VARIABLES)[number];

export const REQUIRED_MERMAID_THEME_VARIABLES = [
  'primaryColor',
  'primaryTextColor',
  'primaryBorderColor',
  'lineColor',
  'secondaryColor',
  'tertiaryColor',
] as const;

export type MermaidThemeVariable = (typeof REQUIRED_MERMAID_THEME_VARIABLES)[number];

export const REQUIRED_XTERM_PALETTE_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionInactiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
