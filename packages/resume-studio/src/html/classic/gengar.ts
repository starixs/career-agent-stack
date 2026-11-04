import type { HtmlTemplate } from "../templates";

/**
 * Gengar / Ditgar 共用的「色块侧栏」版式：
 * - 左侧栏整列浅主色底（主色 20%），要撑满整页：屏幕上画在 .page，打印时画在根元素（根背景铺满整张纸）；
 *   打印时 Chrome 会裁掉伸进 @page 页边的内容，所以 @page 页边归零，左右留白改由各栏内边距承担。
 * - 页眉放侧栏顶部：主色色块、白字、照片在上、联系方式竖排。
 * - 主栏里的「个人总结」提到最上方，浅主色底、不显示标题（旧实现的 featured summary）。
 * - 分区标题主色、0.9 倍字号、下方主色细线；侧栏条目的左右两栏改为上下堆叠。
 */
export const SIDE_PANEL_CSS = `
@page { margin: 0; }
:root { --tint: color-mix(in srgb, var(--primary) 20%, var(--bg)); --panel: linear-gradient(to right, var(--tint) var(--sidebar-w), var(--bg) var(--sidebar-w)); }
.page { background: var(--panel); }
@media print { html { background: var(--panel); } }
.columns.sidebar-left { column-gap: 0; }
.sidebar > .section { padding: 0 var(--margin-x); }
.sidebar > .section:first-child { padding-top: var(--margin-y); }
.header { flex-direction: column; align-items: flex-start; row-gap: calc(var(--gap-y) * 0.5); background: var(--primary); padding: var(--margin-y) var(--margin-x); }
.header .name, .header .headline, .header .contacts, .header .contact .icon { color: var(--bg); }
.header .contacts { flex-direction: column; }
.main { padding: var(--margin-y) var(--margin-x) 0; }
.main:has(> .section[data-id="summary"]) { padding-top: 0; }
.main > .section[data-id="summary"] { order: -1; background: var(--tint); margin: 0 calc(-1 * var(--margin-x)); padding: var(--margin-y) var(--margin-x); }
.main > .section[data-id="summary"] .section-title { display: none; }
.section-title { font-size: calc(var(--heading-size) * 0.9); color: var(--primary); border-bottom: 1px solid var(--primary); padding-bottom: calc(var(--gap-y) * 0.125); }
.sidebar .icon { color: var(--text); }
.sidebar .row { flex-direction: column; align-items: flex-start; }
.sidebar .aside { text-align: left; margin-left: 0; }`;

/** Gengar：色块侧栏版式，整页无上下页边。 */
export const gengar: HtmlTemplate = {
	layout: "sidebar-left",
	header: "sidebar",
	css: `${SIDE_PANEL_CSS}
.page { padding: 0; }
.sidebar, .main { padding-bottom: var(--margin-y); }
.header .contacts { row-gap: calc(var(--gap-y) * 0.25); }`,
};
