import '../fonts.css';
import './career.css';
import stylesheetText from './career.css?inline';
import { createPrismStyle } from '../prism-style';
import type { ThemeDefinition, ThemeSchemeDefinition } from '../types';

const fontCode = "ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code', 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', 'Hiragino Sans GB', monospace";
const xtermFont = "'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'PingFang SC', 'Microsoft YaHei', monospace";
const mermaidFont = "'Career Sans', 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', sans-serif";
const widgetFont = "'Career Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif";

const widgetStructure = {
  '--widget-font-body': widgetFont,
  '--widget-radius-track': '3px',
  '--widget-radius-control': '8px',
  '--widget-radius-card': '10px',
  '--widget-radius-full': '9999px',
  '--widget-control-shadow': '0 1px 3px rgba(0, 0, 0, 0.15)',
} as const;

const lightWidgetVariables = {
  '--widget-text': '#2a241c',
  '--widget-text-secondary': '#5c5244',
  '--widget-text-muted': '#6e6352',
  '--widget-bg': 'transparent',
  '--widget-bg-elevated': '#fffefb',
  '--widget-bg-inset': '#f3eee4',
  '--widget-border': '#e8e1d3',
  '--widget-border-strong': '#d6ccba',
  '--widget-accent': '#2f4ba0',
  '--widget-accent-hover': '#263e86',
  '--widget-accent-subtle': 'rgba(47, 75, 160, 0.08)',
  '--widget-success': '#2e7a4f',
  '--widget-success-bg': '#e4f3e9',
  '--widget-error': '#c0392b',
  '--widget-error-bg': '#fbe6e3',
  '--widget-warning': '#9a5b00',
  '--widget-warning-bg': '#fcefd2',
  '--widget-info': '#2f6e8f',
  '--widget-info-bg': '#e2eef4',
  '--widget-primary-text': '#ffffff',
  ...widgetStructure,
} as const;

const darkWidgetVariables = {
  '--widget-text': '#f1ece3',
  '--widget-text-secondary': '#b0a696',
  '--widget-text-muted': '#9d9385',
  '--widget-bg': 'transparent',
  '--widget-bg-elevated': '#26231e',
  '--widget-bg-inset': '#2a2621',
  '--widget-border': '#38332c',
  '--widget-border-strong': '#4a443b',
  '--widget-accent': '#8fa6f0',
  '--widget-accent-hover': '#a7b9f4',
  '--widget-accent-subtle': 'rgba(143, 166, 240, 0.12)',
  '--widget-success': '#6cc596',
  '--widget-success-bg': '#1d3027',
  '--widget-error': '#f08a7e',
  '--widget-error-bg': '#3d2320',
  '--widget-warning': '#e2a54a',
  '--widget-warning-bg': '#3a2d17',
  '--widget-info': '#6cb8d0',
  '--widget-info-bg': '#1b3038',
  '--widget-primary-text': '#15130f',
  ...widgetStructure,
} as const;

const light: ThemeSchemeDefinition = {
  xterm: {
    palette: {
      background: '#f3eee4', foreground: '#2a241c', cursor: '#2f4ba0', cursorAccent: '#f3eee4',
      selectionBackground: 'rgba(47, 75, 160, 0.18)', selectionForeground: undefined,
      selectionInactiveBackground: 'rgba(47, 75, 160, 0.10)', black: '#2a241c', red: '#b83030',
      green: '#1d7a4e', yellow: '#a85a00', blue: '#3568a0', magenta: '#8f5a8a', cyan: '#2a7560',
      white: '#5c5244', brightBlack: '#6e6352', brightRed: '#c74040', brightGreen: '#2d8a5e',
      brightYellow: '#b87010', brightBlue: '#4a7ab5', brightMagenta: '#a070a0',
      brightCyan: '#3d8a75', brightWhite: '#433a2e',
    },
    fontFamily: xtermFont,
    fontSize: 14,
    lineHeight: 1.3,
  },
  monaco: {
    name: 'career-light',
    fontFamily: fontCode,
    fontSize: 14,
    lineHeight: 22,
    data: {
      base: 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: '9ea1a7', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'a626a4' }, { token: 'keyword.control', foreground: 'a626a4' },
        { token: 'storage', foreground: 'a626a4' }, { token: 'storage.type', foreground: 'a626a4' },
        { token: 'string', foreground: '50a14f' }, { token: 'string.quoted', foreground: '50a14f' },
        { token: 'number', foreground: 'b76b01' }, { token: 'constant', foreground: 'b76b01' },
        { token: 'constant.numeric', foreground: 'b76b01' }, { token: 'type', foreground: 'b76b01' },
        { token: 'type.identifier', foreground: 'b76b01' }, { token: 'class', foreground: 'b76b01' },
        { token: 'function', foreground: '4078f2' }, { token: 'function.call', foreground: '4078f2' },
        { token: 'variable', foreground: '4078f2' }, { token: 'variable.other', foreground: '4078f2' },
        { token: 'operator', foreground: '4078f2' }, { token: 'tag', foreground: 'e45649' },
        { token: 'attribute.name', foreground: 'b76b01' }, { token: 'attribute.value', foreground: '50a14f' },
        { token: 'delimiter', foreground: '383a42' }, { token: 'delimiter.bracket', foreground: '383a42' },
      ],
      colors: {
        'editor.background': '#fdfbf7', 'editor.foreground': '#383a42',
        'editor.lineHighlightBackground': '#f6f2ea', 'editor.selectionBackground': '#e5e5e6',
        'editor.inactiveSelectionBackground': '#f0ede6', 'editorLineNumber.foreground': '#9ea1a7',
        'editorLineNumber.activeForeground': '#383a42', 'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#c8b8a840', 'scrollbarSlider.hoverBackground': '#b8a08860',
        'scrollbarSlider.activeBackground': '#a0906880', 'editorGutter.background': '#fdfbf7',
        'editorCursor.foreground': '#383a42', 'editorIndentGuide.background': '#e8e4db',
        'editorIndentGuide.activeBackground': '#d8d4cb',
      },
    },
  },
  mermaid: {
    theme: 'neutral', fontFamily: mermaidFont,
    themeVariables: {
      primaryColor: '#f3eee4', primaryTextColor: '#2a241c', primaryBorderColor: '#d6ccba',
      lineColor: '#6e6352', secondaryColor: '#f6f2ea', tertiaryColor: '#fffefb',
    },
  },
  prism: createPrismStyle({
    background: '#f3eee4',
    text: '#433a2e',
    textSecondary: '#5c5244',
    muted: '#6e6352',
    accent: '#2f4ba0',
    success: '#2e7a4f',
    error: '#c0392b',
    warning: '#9a5b00',
    info: '#2f6e8f',
    cool: '#2f6e8f',
  }),
  widget: { variables: lightWidgetVariables },
};

const dark: ThemeSchemeDefinition = {
  xterm: {
    palette: {
      background: '#1b1916', foreground: '#f1ece3', cursor: '#8fa6f0', cursorAccent: '#1b1916',
      selectionBackground: 'rgba(143, 166, 240, 0.25)', selectionForeground: undefined,
      selectionInactiveBackground: 'rgba(143, 166, 240, 0.15)', black: '#2a2420', red: '#c75050',
      green: '#2d8a5e', yellow: '#d97706', blue: '#4a7ab5', magenta: '#b07aab', cyan: '#3d8a75',
      white: '#d4c8bc', brightBlack: '#6f6156', brightRed: '#e06060', brightGreen: '#3da872',
      brightYellow: '#f0a030', brightBlue: '#6a9ad0', brightMagenta: '#c894c2',
      brightCyan: '#4da88a', brightWhite: '#efe8e0',
    },
    fontFamily: xtermFont,
    fontSize: 14,
    lineHeight: 1.3,
  },
  monaco: {
    name: 'career-dark',
    fontFamily: fontCode,
    fontSize: 14,
    lineHeight: 22,
    data: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '685c52', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c678dd' }, { token: 'keyword.control', foreground: 'c678dd' },
        { token: 'storage', foreground: 'c678dd' }, { token: 'storage.type', foreground: 'c678dd' },
        { token: 'string', foreground: '98c379' }, { token: 'string.quoted', foreground: '98c379' },
        { token: 'number', foreground: 'd19a66' }, { token: 'constant', foreground: 'd19a66' },
        { token: 'constant.numeric', foreground: 'd19a66' }, { token: 'type', foreground: 'e5c07b' },
        { token: 'type.identifier', foreground: 'e5c07b' }, { token: 'class', foreground: 'e5c07b' },
        { token: 'function', foreground: '61afef' }, { token: 'function.call', foreground: '61afef' },
        { token: 'variable', foreground: 'e06c75' }, { token: 'variable.other', foreground: 'e06c75' },
        { token: 'operator', foreground: '56b6c2' }, { token: 'tag', foreground: 'e06c75' },
        { token: 'attribute.name', foreground: 'd19a66' }, { token: 'attribute.value', foreground: '98c379' },
        { token: 'delimiter', foreground: 'abb2bf' }, { token: 'delimiter.bracket', foreground: 'abb2bf' },
      ],
      colors: {
        'editor.background': '#1b1916', 'editor.foreground': '#d4d4d4',
        'editor.lineHighlightBackground': '#1e1a16', 'editor.selectionBackground': '#3a342c',
        'editor.inactiveSelectionBackground': '#302a22', 'editorLineNumber.foreground': '#685c52',
        'editorLineNumber.activeForeground': '#cfc5ba', 'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#4a403840', 'scrollbarSlider.hoverBackground': '#5a504860',
        'scrollbarSlider.activeBackground': '#6a605880', 'editorGutter.background': '#1b1916',
        'editorCursor.foreground': '#e4dcd4', 'editorIndentGuide.background': '#2a2420',
        'editorIndentGuide.activeBackground': '#3a342c',
      },
    },
  },
  mermaid: {
    theme: 'dark', fontFamily: mermaidFont,
    themeVariables: {
      primaryColor: '#2d2924', primaryTextColor: '#f1ece3', primaryBorderColor: '#4a443b',
      lineColor: '#958b7c', secondaryColor: '#26231e', tertiaryColor: '#201d19',
    },
  },
  prism: createPrismStyle({
    background: '#2d2924',
    text: '#d8d0c3',
    textSecondary: '#b0a696',
    muted: '#958b7c',
    accent: '#8fa6f0',
    success: '#6cc596',
    error: '#f08a7e',
    warning: '#e2a54a',
    info: '#6cb8d0',
    cool: '#6cb8d0',
  }),
  widget: { variables: darkWidgetVariables },
};

const noHeroBackground = {
  assetUrl: null,
  position: 'center',
  size: 'cover',
  repeat: 'no-repeat',
  mask: null,
} as const;

/** The single product Theme. Its ID stays 'keystone-default' so stored configs keep resolving without migration. */
export const careerTheme: ThemeDefinition = {
  id: 'keystone-default',
  displayName: '求职助理',
  description: 'Journal paper, pen-blue accent (specs/CAREER_DESIGN.md)',
  stylesheetText,
  hero: {
    productName: '求职助理',
    slogans: {
      'zh-CN': '陪你把每一次投递认真走完',
      'en-US': 'Every application, done with care',
    },
    backgrounds: { light: noHeroBackground, dark: noHeroBackground },
  },
  schemes: { light, dark },
};
