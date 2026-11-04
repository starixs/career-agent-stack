/**
 * 排满一页：只调两个比例——字号 font（--fs）与间距 space（--sp）。
 *  - 超出一页：字号与间距一起缩，最多缩到 MIN_FONT；缩到底仍放不下就保持原样（正常分页，内容确实多）。
 *  - 不满一页：先拉开间距（最多 MAX_SPACE 倍），还不够再小幅放大字号（最多 MAX_FONT 倍）。
 * 测量由调用方提供（预览测 iframe，导出测 Chrome 页面），这里只做二分。
 */
export type FitScales = { font: number; space: number };
export type Measure = (scales: FitScales) => number | Promise<number>;

/** 字号最多缩到 0.8 倍：再小正文低于约 8pt，HR 读起来吃力（实测 10pt 正文缩到 0.82 仍清楚）。 */
export const MIN_FONT = 0.8;
/**
 * 内容少时只做小幅放大：字号最多 1.08 倍、间距最多 1.5 倍；还填不满就让页底留白，不把整页撑松。
 * 11-04 实测间距拉到 1.9–2.2 倍时分区之间断开，整页显得稀疏，正是用户最早嫌的样子（技能横排后尤其明显）。
 */
export const MAX_FONT = 1.08;
export const MAX_SPACE = 1.5;
/** 填到可用高度的 97% 即视为排满；留 3% 吸收预览与打印引擎的断行差异，避免溢出一行到第二页。 */
export const FILL_TARGET = 0.97;
/** 二分步数：区间宽度 ≤ 0.6，8 步后误差 < 0.003。 */
const STEPS = 8;

async function maxFitting(lo: number, hi: number, at: (v: number) => FitScales, measure: Measure, limit: number) {
	let best = lo;
	for (let i = 0; i < STEPS; i++) {
		const mid = (lo + hi) / 2;
		if ((await measure(at(mid))) <= limit) { best = mid; lo = mid; } else hi = mid;
	}
	return best;
}

export async function fitOnePage(measure: Measure, available: number): Promise<FitScales> {
	const limit = available * FILL_TARGET;
	const natural = await measure({ font: 1, space: 1 });
	if (natural > limit) {
		if ((await measure({ font: MIN_FONT, space: MIN_FONT })) > limit) return { font: 1, space: 1 };
		const s = await maxFitting(MIN_FONT, 1, (v) => ({ font: v, space: v }), measure, limit);
		return { font: s, space: s };
	}
	if ((await measure({ font: 1, space: MAX_SPACE })) > limit) {
		return { font: 1, space: await maxFitting(1, MAX_SPACE, (v) => ({ font: 1, space: v }), measure, limit) };
	}
	return { font: await maxFitting(1, MAX_FONT, (v) => ({ font: v, space: MAX_SPACE }), measure, limit), space: MAX_SPACE };
}

/**
 * 设置比例并返回一页需要的高度（px）= 内容高 + .page 上下内边距（页边距全在 .page 内边距里，见 document.ts）。
 * 渲染层直接调用（CSP 不允许 eval）；导出在 Chrome 里跑同一逻辑的字符串版 MEASURE_SNIPPET，两份须一致（有测试对照）。
 */
export function applyAndMeasure(doc: Document, s: FitScales): number {
	doc.documentElement.style.setProperty("--fs", String(s.font));
	doc.documentElement.style.setProperty("--sp", String(s.space));
	const page = doc.querySelector(".page");
	const content = doc.querySelector(".content");
	if (!page || !content) return 0;
	const cs = doc.defaultView?.getComputedStyle(page);
	const pad = cs ? Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) : 0;
	return content.getBoundingClientRect().height + pad;
}

export const MEASURE_SNIPPET = (s: FitScales) =>
	`(() => { const d = document; d.documentElement.style.setProperty('--fs', '${s.font}'); d.documentElement.style.setProperty('--sp', '${s.space}'); const p = d.querySelector('.page'); const c = d.querySelector('.content'); if (!p || !c) return 0; const cs = getComputedStyle(p); return c.getBoundingClientRect().height + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom); })()`;

/** 纸高（CSS px，96dpi）。 */
export const paperHeightPx = (pageHeightMm: number) => (pageHeightMm / 25.4) * 96;
