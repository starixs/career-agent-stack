import type { HtmlTemplate } from "../templates";

/** Lapras：页眉与每个分区都是浅灰描边圆角卡片，分区标题压在卡片上边框上（类 fieldset）。 */
export const lapras: HtmlTemplate = {
	layout: "stack",
	css: `
.content, .columns, .main { row-gap: calc(var(--gap-y) * 1.5); }
.header { border: 1px solid #CCCCCC; border-radius: 8px; padding: var(--gap-x); column-gap: var(--gap-x); }
.section { position: relative; border: 1px solid #CCCCCC; border-radius: 8px; background: var(--bg); padding: var(--gap-x); margin-top: calc(var(--heading-size) * 0.4); }
.section:has(> .section-title) { padding-top: calc(var(--gap-x) + var(--heading-size) * 0.4); }
.section-title { position: absolute; top: 0; left: var(--gap-x); transform: translateY(-50%); background: var(--bg); padding: 0 var(--gap-x); margin: 0; white-space: nowrap; }`,
};
