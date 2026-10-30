/**
 * 简单验证码 AI 自己过（世界模型 §4，2026-10-30）：图形字、点选、滑块拼图 / 旋转。过不了再请用户帮一下。
 * 短信码、二次验证永远交给用户；浏览器环境检查（Cloudflare 一类）只等它自己放行。
 *
 * 视觉模型报坐标不准（投递引擎 VlmPerceiver 的经验），所以不让它报像素：
 * 点选在截图上叠编号网格，让它报格子号；滑块叠横向刻度，让它报刻度号。换算成坐标由代码做。
 */
import type { Page } from 'playwright';

import { inPage } from './browse';
import { humanDrag } from './browse-pointer';

export type SolvableKind = 'image_text' | 'image_click' | 'slider';
export interface Box { x: number; y: number; width: number; height: number }
export interface CaptchaLayout { region: Box; input: Box | null; handle: Box | null; confirm: Box | null; instruction: string; rotate: boolean }
export interface VisionLlm { complete(request: { system?: string; messages: Array<{ role: 'user'; content: string; images?: Array<{ mediaType: 'image/png'; data: string }> }>; json?: boolean; temperature?: number }): Promise<{ text: string }> }
export interface SolveDeps { llm: VisionLlm; overlay: (png: Buffer, marks: GridMarks) => Promise<Buffer>; sleep?: (ms: number) => Promise<void> }

/** 网格边长 / 刻度间距（截图像素）。点选的字一般 30～40px，格子比字小一点才点得准。 */
export const GRID_CELL_PX = 30;
export const TICK_PX = 10;
export interface GridMarks { kind: 'grid' | 'ticks'; cols: number; rows: number; cell: number }

/** 页内：找验证码区域、输入框、滑块把手、确认按钮和题面文字。不能引用外部变量。 */
export function locateCaptchaInPage(): CaptchaLayout | null {
  const RX = /captcha|verify|vcode|geetest|nc_|tcaptcha|yidun|slide|slider|puzzle|vercode|antispider|seccode/i;
  const vis = (el: Element) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 20 && r.height > 15 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
  const sig = (el: Element) => `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('src') || ''}`;
  const area = innerWidth * innerHeight;
  const cands = Array.from(document.querySelectorAll('div, img, canvas, section, form')).filter(el => RX.test(sig(el)) && vis(el)).filter(el => { const r = el.getBoundingClientRect(); return r.width * r.height < area * 0.7; });
  const region = cands.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!region) return null;
  const scope = region.closest('form') ?? region.parentElement ?? document.body;
  const input = Array.from(scope.querySelectorAll('input[type=text], input:not([type])')).find(vis) ?? null;
  const handle = Array.from(document.querySelectorAll('[class*=slider] [class*=btn], [class*=handle], [class*=knob], [class*=slider_btn], [class*=drag], [class*=slide-btn], [class*=slider-button]')).find(vis) ?? null;
  const confirm = Array.from(scope.querySelectorAll('button, a, [role=button], input[type=submit]')).find(el => vis(el) && /确定|确认|验证|提交|submit|verify/i.test((el as HTMLElement).innerText || (el as HTMLInputElement).value || '')) ?? null;
  const instruction = ((region.closest('form') ?? region.parentElement ?? region) as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { region: box(region)!, input: box(input), handle: box(handle), confirm: box(confirm), instruction, rotate: /使图片为正|旋转|摆正|rotate/i.test(document.body.innerText) };
}

/** 网格：截图尺寸 → 行列。 */
export function gridOf(width: number, height: number, kind: GridMarks['kind']): GridMarks {
  return kind === 'grid'
    ? { kind, cols: Math.max(1, Math.round(width / GRID_CELL_PX)), rows: Math.max(1, Math.round(height / GRID_CELL_PX)), cell: GRID_CELL_PX }
    : { kind, cols: Math.max(1, Math.floor(width / TICK_PX)), rows: 1, cell: TICK_PX };
}

/** 格子号（从 1 开始，按行）→ 区域内的中心坐标。 */
export function cellCenter(marks: GridMarks, n: number, region: Box): { x: number; y: number } | null {
  if (!Number.isInteger(n) || n < 1 || n > marks.cols * marks.rows) return null;
  const cw = region.width / marks.cols; const ch = region.height / marks.rows;
  const col = (n - 1) % marks.cols; const row = Math.floor((n - 1) / marks.cols);
  return { x: Math.round(region.x + cw * (col + 0.5)), y: Math.round(region.y + ch * (row + 0.5)) };
}

const parseJson = (text: string): Record<string, unknown> => {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`视觉模型没有给出 JSON：${text.slice(0, 80)}`);
  return JSON.parse(m[0]) as Record<string, unknown>;
};

const PROMPTS: Record<SolvableKind, (layout: CaptchaLayout, marks: GridMarks) => string> = {
  image_text: () => '图里是一个图形验证码。只输出图里的字符（区分大小写，不要空格），格式 {"text":"..."}。',
  image_click: (l, m) => `这是一个点选验证码，题面：「${l.instruction}」。图上叠了编号网格（${m.cols} 列 × ${m.rows} 行，从左上角 1 开始按行编号）。按题面要求的顺序，给出每个目标所在格子的编号，格式 {"cells":[n1,n2,...]}。`,
  slider: (l, m) => l.rotate
    ? '这是一个旋转验证码：要把图片转正。估计需要顺时针转多少度（0-360），格式 {"angle":度数}。'
    : `这是一个滑块拼图验证码。图上方标了 ${m.cols} 个刻度（每格 ${m.cell} 像素，从 0 开始）。给出拼图块当前左边缘的刻度和缺口左边缘的刻度，格式 {"piece":n,"gap":n}。`,
};

async function askVision(page: Page, layout: CaptchaLayout, kind: SolvableKind, deps: SolveDeps): Promise<{ answer: Record<string, unknown>; marks: GridMarks }> {
  const marks = gridOf(layout.region.width, layout.region.height, kind === 'image_click' ? 'grid' : 'ticks');
  const png = await page.screenshot({ type: 'png', clip: layout.region });
  const img = kind === 'image_text' ? png : await deps.overlay(png, marks);
  const res = await deps.llm.complete({ messages: [{ role: 'user', content: PROMPTS[kind](layout, marks), images: [{ mediaType: 'image/png', data: img.toString('base64') }] }], json: true, temperature: 0 });
  return { answer: parseJson(res.text), marks };
}

/** 按模型的答案操作一次。返回做了什么（给日志 / 回执）。 */
export async function applyAnswer(page: Page, layout: CaptchaLayout, kind: SolvableKind, answer: Record<string, unknown>, marks: GridMarks, sleep: (ms: number) => Promise<void>): Promise<string> {
  if (kind === 'image_text') {
    const value = String(answer.text ?? '').trim();
    if (!value || !layout.input) throw new Error(!value ? '模型没读出字符' : '找不到验证码输入框');
    await page.mouse.click(layout.input.x + layout.input.width / 2, layout.input.y + layout.input.height / 2);
    await page.keyboard.type(value, { delay: 60 + Math.random() * 60 });
    await page.keyboard.press('Enter');
    return `填了 ${value.length} 个字符`;
  }
  if (kind === 'image_click') {
    const points = (Array.isArray(answer.cells) ? answer.cells : []).map(n => cellCenter(marks, Number(n), layout.region));
    if (!points.length || points.some(p => !p)) throw new Error(`格子号不对：${JSON.stringify(answer.cells)}`);
    for (const p of points) { await page.mouse.click(p!.x, p!.y, { delay: 50 }); await sleep(300 + Math.random() * 300); }
    if (layout.confirm) await page.mouse.click(layout.confirm.x + layout.confirm.width / 2, layout.confirm.y + layout.confirm.height / 2);
    return `依次点了 ${points.length} 处`;
  }
  if (!layout.handle) throw new Error('找不到滑块把手');
  const distance = layout.rotate
    ? (Number(answer.angle) / 360) * Math.max(layout.region.width - layout.handle.width, 1)
    : (Number(answer.gap) - Number(answer.piece)) * marks.cell;
  if (!Number.isFinite(distance) || distance <= 0) throw new Error(`拖动距离不对：${JSON.stringify(answer)}`);
  const from = { x: layout.handle.x + layout.handle.width / 2, y: layout.handle.y + layout.handle.height / 2 };
  await humanDrag(page, from, { x: from.x + distance, y: from.y }, sleep);
  return `拖了 ${Math.round(distance)} 像素`;
}

export interface SolveOutcome { status: 'solved' | 'failed'; attempts: number; steps: string[] }
/** 最多试这么多次：多数验证码失败两次就换更难的题或锁定，再试只会触发风控。 */
export const CAPTCHA_MAX_ATTEMPTS = 2;
/** 操作后等结果的时间：验证码校验、页面跳转。 */
const VERIFY_SETTLE_MS = 1800;

/** 解一次验证码：定位 → 截图 → 问模型 → 操作 → 看挡路的还在不在。stillBlocked 由调用方给（用和观察同一套提示）。 */
export async function solveCaptcha(page: Page, kind: SolvableKind, deps: SolveDeps, stillBlocked: () => Promise<boolean>): Promise<SolveOutcome> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const steps: string[] = [];
  for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS; attempt++) {
    const layout = await inPage(page, locateCaptchaInPage, null);
    if (!layout) { steps.push('页面上找不到验证码区域'); return { status: 'failed', attempts: attempt, steps }; }
    try {
      const { answer, marks } = await askVision(page, layout, kind, deps);
      steps.push(`第 ${attempt} 次：${await applyAnswer(page, layout, kind, answer, marks, sleep)}`);
    } catch (error) {
      steps.push(`第 ${attempt} 次没做成：${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    }
    await sleep(VERIFY_SETTLE_MS);
    if (!(await stillBlocked())) return { status: 'solved', attempts: attempt, steps };
  }
  return { status: 'failed', attempts: CAPTCHA_MAX_ATTEMPTS, steps };
}
