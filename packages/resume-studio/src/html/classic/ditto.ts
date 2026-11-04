import type { HtmlTemplate } from "../templates";

/**
 * Ditto：顶部整宽主色横幅（姓名 + 头衔，白字），照片居中压在侧栏宽度的横幅左段、向下叠出；
 * 联系方式在横幅下方、与主栏对齐；左侧栏、无侧栏底色，分区标题主色。
 *
 * 横幅要撑满整张纸，而打印时 Chrome 会裁掉伸进 @page 页边的内容，所以本模板把 @page 页边归零、
 * 由 .page 自己留底边；左右页边改为侧栏左内边距与主栏右内边距。
 */
export const ditto: HtmlTemplate = {
	layout: "sidebar-left",
	css: `
@page { margin: 0; }
.page { padding: 0 0 var(--margin-y); }
.header {
  display: grid; grid-template-columns: var(--sidebar-w) 1fr; align-items: start;
  column-gap: 0; row-gap: 0; position: relative;
}
.header .identity { grid-column: 2; row-gap: 0; }
.header .name, .header .headline {
  background: var(--primary); color: var(--bg);
  box-shadow: 0 0 0 100vmax var(--primary); clip-path: inset(0 -100vmax);
  padding: 0 var(--margin-x);
}
.header .name { padding-top: var(--margin-y); clip-path: inset(0 -100vmax -1px); }
.header .headline, .header .name:has(+ .contacts) { padding-bottom: var(--margin-y); }
.header .headline { padding-top: calc(var(--gap-y) * 0.35); }
.header .contacts { padding: var(--margin-y) var(--margin-x) 0; column-gap: calc(var(--gap-x) * 2 / 3); row-gap: calc(var(--gap-y) * 0.125); }
.header .photo {
  grid-column: 1; grid-row: 1; justify-self: center; position: relative; z-index: 1;
  margin-top: calc(var(--margin-y) * 0.75); margin-bottom: -1000pt;
}
.header .identity { grid-row: 1; }
.columns.sidebar-left { column-gap: 0; }
.sidebar { padding-left: var(--margin-x); }
.header:has(.photo) + .columns .sidebar { padding-top: var(--margin-y); }
.main { padding: 0 var(--margin-x) 0 var(--margin-x); }
.section-title { color: var(--primary); }
.sidebar .row { flex-direction: column; align-items: flex-start; }
.sidebar .aside { text-align: left; margin-left: 0; }`,
};
