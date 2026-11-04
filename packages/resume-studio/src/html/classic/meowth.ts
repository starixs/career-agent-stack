import type { HtmlTemplate } from "../templates";

/** Meowth：照片在页眉右侧，单列；分区标题大写、主色，下方主色细线。 */
export const meowth: HtmlTemplate = {
	layout: "stack",
	css: `
.header { align-items: flex-start; column-gap: var(--gap-x); }
.header .photo { order: 2; }
.headline { opacity: 0.8; }
.section-title { color: var(--primary); text-transform: uppercase; border-bottom: 1px solid var(--primary); padding-bottom: calc(var(--gap-y) * 0.125); }
/* 经历 / 教育的条目头排成一行三段：职位|专业 · 公司|学校（粗体）· 时间；地点 / 学位挪到第二行 */
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; column-gap: calc(var(--gap-x) * 0.75); }
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head > .row { display: contents; }
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head > .row:first-child > .primary { grid-row: 1; grid-column: 2; }
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head > .row:first-child > .aside { grid-row: 2; grid-column: 1 / -1; text-align: left; margin: 0; }
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head > .row:nth-child(2) > .secondary { grid-row: 1; grid-column: 1; color: var(--text); }
:is([data-section="experience"], [data-section="education"]) > .items > .item > .item-head > .row:nth-child(2) > .aside { grid-row: 1; grid-column: 3; color: var(--text); }`,
};
