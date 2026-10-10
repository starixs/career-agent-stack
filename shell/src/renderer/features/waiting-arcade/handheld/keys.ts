import type { HandheldButton } from './screen';

/** 按 KeyboardEvent.code 映射（物理键位），输入法 / 键盘布局不影响。 */
const KEY_BUTTONS: Record<string, HandheldButton> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyX: 'a', KeyK: 'a', Space: 'a',
  KeyZ: 'b', KeyJ: 'b',
  Enter: 'start', NumpadEnter: 'start',
  ShiftLeft: 'select', ShiftRight: 'select',
  KeyQ: 'l', KeyE: 'r',
};

export function keyToButton(code: string): HandheldButton | null {
  return KEY_BUTTONS[code] ?? null;
}

const DPAD = new Set<HandheldButton>(['up', 'down', 'left', 'right']);
export const isDpad = (button: HandheldButton) => DPAD.has(button);
