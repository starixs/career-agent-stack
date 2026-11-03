import type { HtmlTemplate } from "../templates";

/** Bronzor：居中页眉（照片在姓名上方），单列交替排布；每个分区左侧是主色小标题标签栏、上方主色细线。 */
export const bronzor: HtmlTemplate = {
	layout: "interleave",
	css: `
.header { flex-direction: column; text-align: center; row-gap: calc(var(--gap-y) * 0.5); }
.header .identity { align-items: center; }
.header .contacts { justify-content: center; }
.section { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); column-gap: var(--margin-x); border-top: 1px solid var(--primary); padding-top: calc(var(--gap-y) * 0.5); }
.section-title { font-size: calc(var(--heading-size) * 0.75); color: var(--primary); margin-bottom: 0; align-self: start; }
.section > .items { grid-column: 2; }`,
};
