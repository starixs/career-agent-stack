import type { HtmlTemplate } from "../templates";

/** Azurill：居中页眉、左侧栏、主栏条目带时间轴（竖线 + 空心圆点）。 */
export const azurill: HtmlTemplate = {
	layout: "sidebar-left",
	css: `
.header { flex-direction: column; text-align: center; }
.header .contacts { justify-content: center; }
.section-title { color: var(--primary); }
.main .items { position: relative; padding-left: 16px; }
.main .items::before { content: ""; position: absolute; left: 4px; top: 4px; bottom: 4px; width: 1px; background: var(--primary); }
.main .item { position: relative; }
.main .item::before { content: ""; position: absolute; left: -16px; top: 0.45em; width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--primary); background: var(--bg); }
.main .roles .item::before { display: none; }`,
};
