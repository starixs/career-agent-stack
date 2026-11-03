import type { HtmlTemplate } from "../templates";

/** Kakuna：居中页眉（照片在姓名上方），单列；分区标题居中、主色，下方主色细线。 */
export const kakuna: HtmlTemplate = {
	layout: "stack",
	css: `
.header { flex-direction: column; text-align: center; row-gap: calc(var(--gap-y) * 0.5); }
.header .identity { align-items: center; width: 100%; }
.header .contacts { justify-content: center; }
.section-title { justify-content: center; text-align: center; color: var(--primary); border-bottom: 1px solid var(--primary); padding-bottom: calc(var(--gap-y) * 0.125); }`,
};
