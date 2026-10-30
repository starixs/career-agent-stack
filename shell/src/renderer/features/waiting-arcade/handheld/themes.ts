// 关卡场景：每进一关，整块屏幕换一套配色和环境粒子，让玩家一直觉得新鲜。
// 游戏只管自己的关卡数（ArcadeGame.stage ?? level），换景、过场和场景名由屏幕统一做。
//
// 原则：玩法和角色不变，只换环境。规则、操作、角色形状一律不动；角色用的
// primary / accent / danger 在所有浅色场景里是同一组颜色，深色场景只提亮同一色相，
// 换景后一眼还认得出谁是自己、谁是敌人。变的是底色、文字灰阶、网格线和环境粒子。
// 自带深色配色的游戏（坦克）只换底色和网格线。

import type { ArcadePalette } from '../games';

export type Ambient = 'none' | 'motes' | 'leaves' | 'stars' | 'petals' | 'rain' | 'snow' | 'sand';
export type ThemeId = 'lcd' | 'dusk' | 'mint' | 'night' | 'sakura' | 'neon' | 'snow' | 'desert';

export interface StageTheme {
  id: ThemeId;
  palette: ArcadePalette;
  ambient: Ambient;
}

/** 反射式彩色 LCD 的偏灰配色：掌机是实体物件，不跟随 App 主题。 */
export const LCD_PALETTE: ArcadePalette = {
  bg: '#cdd3bf',
  ink: '#1c2230',
  muted: '#5f6857',
  line: '#a4ad94',
  primary: '#2c5aa8',
  accent: '#c63f36',
  danger: '#b8501c',
};

const LIGHT_THEMES: readonly StageTheme[] = [
  { id: 'lcd', palette: LCD_PALETTE, ambient: 'none' },
  {
    id: 'dusk', ambient: 'motes',
    palette: { bg: '#efd6b0', ink: '#3b2430', muted: '#8a6455', line: '#d8b48a', primary: '#2c5aa8', accent: '#c63f36', danger: '#b8501c' },
  },
  {
    id: 'mint', ambient: 'leaves',
    palette: { bg: '#cfe6da', ink: '#183634', muted: '#557a70', line: '#a6cbbb', primary: '#2c5aa8', accent: '#c63f36', danger: '#b8501c' },
  },
  {
    id: 'night', ambient: 'stars',
    palette: { bg: '#1b2136', ink: '#e6e9f5', muted: '#8a92b4', line: '#2f3858', primary: '#6aa8ff', accent: '#ff6b6b', danger: '#ff9a4a' },
  },
  {
    id: 'sakura', ambient: 'petals',
    palette: { bg: '#f5dde3', ink: '#3a2230', muted: '#977080', line: '#e6bccb', primary: '#2c5aa8', accent: '#c63f36', danger: '#b8501c' },
  },
  {
    id: 'neon', ambient: 'rain',
    palette: { bg: '#140c22', ink: '#f2e9ff', muted: '#9a84c0', line: '#2d1f48', primary: '#6aa8ff', accent: '#ff6b6b', danger: '#ff9a4a' },
  },
  {
    id: 'snow', ambient: 'snow',
    palette: { bg: '#e9f0f7', ink: '#1d2a3a', muted: '#7b8ca2', line: '#c9d7e6', primary: '#2c5aa8', accent: '#c63f36', danger: '#b8501c' },
  },
  {
    id: 'desert', ambient: 'sand',
    palette: { bg: '#e6cf9c', ink: '#3a2a14', muted: '#8a6f45', line: '#cfb27a', primary: '#2c5aa8', accent: '#c63f36', danger: '#b8501c' },
  },
];

/** 深色游戏的场景：只给底色和网格线。第一项留空，用游戏自己的。 */
const DARK_SCENES: readonly { id: ThemeId; bg?: string; line?: string; ambient: Ambient }[] = [
  { id: 'night', ambient: 'none' },
  { id: 'dusk', bg: '#1d1416', line: '#3a2a2c', ambient: 'motes' },
  { id: 'neon', bg: '#130b1f', line: '#2d1f48', ambient: 'rain' },
  { id: 'desert', bg: '#1b160d', line: '#3a301c', ambient: 'sand' },
  { id: 'snow', bg: '#0f1720', line: '#26364a', ambient: 'snow' },
  { id: 'mint', bg: '#0c1714', line: '#1f3a33', ambient: 'leaves' },
];

/** 第 stage 关用哪套场景；超出列表后从头轮换。own 是游戏自带的配色。 */
export function themeForStage(stage: number, own?: ArcadePalette): StageTheme {
  const i = Math.max(0, stage - 1);
  if (!own) return LIGHT_THEMES[i % LIGHT_THEMES.length];
  const scene = DARK_SCENES[i % DARK_SCENES.length];
  return {
    id: scene.id,
    ambient: scene.ambient,
    palette: { ...own, bg: scene.bg ?? own.bg, line: scene.line ?? own.line },
  };
}
