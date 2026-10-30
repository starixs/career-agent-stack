/**
 * 坐标级操作（computer use 那一层）：按视口坐标点、拖。DOM 编号够用时不用它；
 * 用在 DOM 编不了号的地方——画布、图片验证码、滑块。
 *
 * 闸和编号点击一致：坐标下面是提交 / 投递类按钮就不点（专门的验证页除外：那里的「提交」只是过验证，不是对外发出）。
 */
import type { Page } from 'playwright';

export interface PointTarget { text: string; kind: string }

/** 坐标下面那个可点的东西（往上找到按钮 / 链接为止）。页内执行，不能引用外部变量。 */
export function pointTargetInPage(arg: { x: number; y: number }): PointTarget | null {
  const hit = document.elementFromPoint(arg.x, arg.y);
  if (!hit) return null;
  const clickable = hit.closest('a[href], button, input, select, textarea, [role=button], [role=link], [onclick]') ?? hit;
  const h = clickable as HTMLElement & { value?: string };
  const text = (h.getAttribute('aria-label') || h.innerText || (h.tagName === 'INPUT' ? h.value : '') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { text, kind: clickable.tagName.toLowerCase() };
}

/** 专门的验证 / 反爬页（整页就是一个验证码）：这里的「提交」是过验证，可以点。 */
export const VERIFICATION_URL_RX = /verify|captcha|security-check|antispider|antibot|challenge/i;

/** 拖动的步数与总时长：太快太直的轨迹是滑块验证判机器人的主要依据。 */
const DRAG_STEPS = 28;
const DRAG_TOTAL_MS = 900;
/** 拖到终点后再多走一点再回来（人手常见的过冲），像素。 */
const DRAG_OVERSHOOT_PX = 4;

/** 先快后慢、带一点上下抖动和过冲的拖动。 */
export async function humanDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, sleep: (ms: number) => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const dx = to.x - from.x + Math.sign(to.x - from.x || 1) * DRAG_OVERSHOOT_PX;
  const dy = to.y - from.y;
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const t = i / DRAG_STEPS;
    const eased = 1 - (1 - t) ** 3;
    await page.mouse.move(from.x + dx * eased, from.y + dy * eased + (Math.random() - 0.5) * 2);
    await sleep(DRAG_TOTAL_MS / DRAG_STEPS * (0.6 + Math.random() * 0.8));
  }
  await page.mouse.move(to.x, to.y, { steps: 3 });
  await sleep(120);
  await page.mouse.up();
}
