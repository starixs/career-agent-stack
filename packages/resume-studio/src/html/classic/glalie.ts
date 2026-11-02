import type { HtmlTemplate } from "../templates";

/** 侧栏底色：主色 20% 调到底色上，与旧版 getPrimaryTint(0.2) 一致。 */
const TINT = "color-mix(in srgb, var(--primary) 20%, var(--bg))";
const STRIP = `linear-gradient(${TINT}, ${TINT}) left top / var(--sidebar-w) 100% repeat-y, var(--bg)`;

/**
 * Glalie：左侧栏整列浅主色底（贯穿纸面上下左边），页眉居中放在侧栏顶部，
 * 联系方式竖排在主色细框里；分区标题主色带主色下划线；侧栏条目抬头竖排。
 *
 * 整列底色要贴纸边，而打印时页边距区会被裁掉：所以页边距归零，左右留白改成两栏各自的内边距
 * （与旧版一样，侧栏宽 = 纸宽 × --sidebar-w，含内边距），上下留白由 .page 的内边距按页克隆。
 * 底色打印时画在根元素背景上（每页都铺满），屏幕上画在 .page 上。
 */
export const glalie: HtmlTemplate = {
	layout: "sidebar-left",
	header: "sidebar",
	css: `
@page { margin: 0; }
.page { padding: var(--margin-y) 0; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
@media print { html { background: ${STRIP}; } body, .page { background: transparent; } }
@media screen { .page { background: ${STRIP}; } }
.columns.sidebar-left { column-gap: 0; }
.sidebar, .main { padding: 0 var(--margin-x); }
.header { flex-direction: column; text-align: center; row-gap: calc(var(--gap-y) * 0.5); }
.header .identity { width: 100%; align-items: center; }
.header .contacts { flex-direction: column; align-items: flex-start; width: 100%; text-align: left; border: 1px solid var(--primary); padding: calc(var(--gap-x) * 0.75); row-gap: 2pt; }
.section-title { color: var(--primary); border-bottom: 1px solid var(--primary); }
.sidebar .row { flex-direction: column; }
.sidebar .aside { text-align: left; margin-left: 0; }`,
};
