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
/** 内容少时字号最多放大到 1.12 倍：再大会显得字大空洞（实测 1.3 倍已明显过大）。 */
export const MAX_FONT = 1.12;
/** 间距最多拉到 2.2 倍：超过后分区之间断开感太强。 */
export const MAX_SPACE = 2.2;
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

/** 页面里执行：设置比例并返回内容高度（px）。导出时序列化成字符串在 Chrome 里跑，故不引用外部变量。 */
export const MEASURE_SNIPPET = (s: FitScales) =>
	`(() => { const r = document.documentElement.style; r.setProperty('--fs', '${s.font}'); r.setProperty('--sp', '${s.space}'); return document.querySelector('.content').getBoundingClientRect().height; })()`;

/** 可用内容高度（CSS px，96dpi）：纸高减上下页边距。 */
export const availableHeightPx = (pageHeightMm: number, marginYPt: number) => (pageHeightMm * 72) / 25.4 / 0.75 - (2 * marginYPt) / 0.75;
