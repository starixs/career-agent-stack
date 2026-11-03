import type { HtmlTemplate } from "../templates";

/**
 * Pikachu：照片在左侧栏顶部，页眉是主栏顶部的一块主色圆角色块（字用底色），
 * 姓名 / 职位与联系方式之间一条底色细线；分区标题主色带主色下划线；侧栏条目抬头竖排。
 */
export const pikachu: HtmlTemplate = {
	layout: "sidebar-left",
	header: "main",
	photo: "sidebar",
	css: `
.header { background: var(--primary); border-radius: 4pt; padding: var(--margin-y) var(--margin-x); }
.header .identity { row-gap: calc(var(--gap-y) * 0.5); }
.header .name, .header .headline, .header .contact, .header .contact .icon { color: var(--bg); }
.header .contacts { border-top: 1px solid var(--bg); padding-top: calc(var(--gap-y) * 0.5); column-gap: calc(var(--gap-x) * 0.75); }
.sidebar > .photo { align-self: flex-start; }
.section-title { color: var(--primary); border-bottom: 1px solid var(--primary); }
.sidebar .row { flex-direction: column; }
.sidebar .aside { text-align: left; margin-left: 0; }`,
};
