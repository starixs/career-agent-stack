import type { HtmlTemplate } from "../templates";

const STRIP = "linear-gradient(var(--primary), var(--primary)) right top / var(--sidebar-w) 100% repeat-y, var(--bg)";

/**
 * Chikorita：主栏在左（页眉在主栏顶部），右侧栏整列主色底（贯穿纸面上下右边），
 * 侧栏里文字和标题都改用底色；分区标题略小、带同色下划线；侧栏条目抬头竖排。
 *
 * 整列底色要贴纸边，而打印时页边距区会被裁掉：所以页边距归零，左右留白改成两栏各自的内边距
 * （与旧版一样，侧栏宽 = 纸宽 × --sidebar-w，含内边距），上下留白由 .page 的内边距按页克隆。
 * 底色打印时画在根元素背景上（每页都铺满），屏幕上画在 .page 上。
 */
export const chikorita: HtmlTemplate = {
	layout: "sidebar-right",
	header: "main",
	css: `
@page { margin: 0; }
.page { padding: var(--margin-y) 0; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
@media print { html { background: ${STRIP}; } body, .page { background: transparent; } }
@media screen { .page { background: ${STRIP}; } }
.columns.sidebar-right { column-gap: 0; }
.sidebar, .main { padding: 0 var(--margin-x); }
.header { align-items: flex-start; column-gap: calc(var(--gap-x) * 0.5); }
.section-title { font-size: calc(var(--heading-size) * 0.85); color: var(--primary); border-bottom: 1px solid var(--primary); padding-bottom: calc(var(--gap-y) * 0.125); margin-bottom: calc(var(--gap-y) * 0.375); }
.sidebar { --primary: var(--bg); --ink: var(--bg); --text: var(--bg); --muted: color-mix(in srgb, var(--bg) 85%, transparent); color: var(--text); }
.sidebar .row { flex-direction: column; }
.sidebar .aside { text-align: left; margin-left: 0; }`,
};
