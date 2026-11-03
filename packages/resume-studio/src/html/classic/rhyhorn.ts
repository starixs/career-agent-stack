import type { HtmlTemplate } from "../templates";

/** Rhyhorn：单栏，照片在页眉右侧；联系方式之间用主色竖线分隔；分区标题主色、下方主色细线。 */
export const rhyhorn: HtmlTemplate = {
	layout: "stack",
	css: `
.header { column-gap: calc(var(--gap-x) * 0.5); }
.header .photo { order: 2; }
.identity { row-gap: calc(var(--gap-y) * 0.5); }
.contacts { column-gap: 0; row-gap: calc(var(--gap-y) * 0.125); }
.contact { padding-right: calc(var(--gap-x) * 0.5); margin-right: calc(var(--gap-x) * 0.5); border-right: 1px solid var(--primary); }
.contact:last-child { padding-right: 0; margin-right: 0; border-right: 0; }
.section-title { color: var(--primary); border-bottom: 1px solid var(--primary); }`,
};
