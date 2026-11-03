import type { HtmlTemplate } from "../templates";

/**
 * Leafish：通栏页眉（主色 10% 底）+ 联系方式色带（主色 20% 底），主栏在左、侧栏在右，
 * 分区标题主色带主色下划线。
 */
export const leafish: HtmlTemplate = {
	layout: "sidebar-right",
	// 页眉色块要贴到纸边：去掉 .page 的上、左、右内边距（引擎的 @page 页边距为 0），
	// 改由 .header / .columns 自己留白。
	css: `
.page { padding: 0 0 var(--margin-y); }
.columns { padding: 0 var(--margin-x); }
.header { padding: var(--margin-y) var(--margin-x) 0; background: color-mix(in srgb, var(--primary) 10%, var(--bg)); display: grid; grid-template-columns: 1fr; align-items: center; }
.header:has(.photo) { grid-template-columns: auto 1fr; }
.header .identity { display: contents; }
.header .photo { grid-row: 1 / 3; }
.header:has(.photo) .name, .header:has(.photo) .headline { grid-column: 2; }
.header .name { align-self: end; }
.header .headline { align-self: start; }
.header .contacts { grid-column: 1 / -1; margin: 0 calc(-1 * var(--margin-x)); padding: var(--margin-y) var(--margin-x); column-gap: var(--gap-x); background: color-mix(in srgb, var(--primary) 20%, var(--bg)); }
.section-title { color: var(--primary); border-bottom: 1px solid var(--primary); }`,
};
