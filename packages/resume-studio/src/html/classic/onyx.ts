import type { HtmlTemplate } from "../templates";

/** Onyx：经典单栏，页眉下方主色细线，分区标题主色。 */
export const onyx: HtmlTemplate = {
	layout: "stack",
	css: `
.header { border-bottom: 1px solid var(--primary); padding-bottom: var(--margin-y); }
.section-title { color: var(--primary); }`,
};
