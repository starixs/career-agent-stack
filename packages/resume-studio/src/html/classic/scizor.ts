import type { HtmlTemplate } from "../templates";

/** Scizor：纸张顶端主色粗条，大号姓名下一道灰色短线，照片在右；分区上方灰色分隔线、标题大写加粗。 */
export const scizor: HtmlTemplate = {
	layout: "stack",
	css: `
/* 引擎的 @page 页边距为 0，根元素背景从纸边开始画，顶条直接贴住纸边（屏幕与打印同一份） */
html { background: linear-gradient(var(--primary), var(--primary)) 0 0 / 100% calc(var(--gap-y) * 0.45) no-repeat, var(--bg); }
body, .page { background: transparent; }
.header { align-items: flex-start; column-gap: var(--gap-x); padding-bottom: calc(var(--gap-y) * 0.35); }
.header .photo { order: 2; }
.identity { row-gap: calc(var(--gap-y) * 0.45); }
.name { font-size: calc(var(--heading-size) * 1.85); font-weight: 700; }
.name::after { content: ""; display: block; width: 72%; border-bottom: 2px solid #D8DCE2; margin-top: calc(var(--gap-y) * 0.45); }
.section { border-top: 1px solid #D8DCE2; padding-top: calc(var(--gap-y) * 0.65); }
.section-title { font-size: calc(var(--heading-size) * 0.9); font-weight: 700; text-transform: uppercase; color: var(--ink); }`,
};
