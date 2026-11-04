import type { HtmlTemplate } from "../templates";
import { SIDE_PANEL_CSS } from "./gengar";

/**
 * Ditgar：同 Gengar 的色块侧栏版式（见 SIDE_PANEL_CSS），区别在保留底部页边（侧栏底色铺进页边），
 * 主栏条目标题左侧挂一道 2px 主色竖线，竖线伸到正文左缘之外，标题文字仍与正文对齐。
 */
export const ditgar: HtmlTemplate = {
	layout: "sidebar-left",
	header: "sidebar",
	css: `${SIDE_PANEL_CSS}
.page { padding: 0 0 var(--margin-y); }
.header .contacts { row-gap: calc(var(--gap-y) * 0.125); }
.main .item-head {
  border-left: 2px solid var(--primary);
  padding: calc(var(--gap-y) * 0.125) 0 calc(var(--gap-y) * 0.125) calc(var(--gap-x) * 0.5);
  margin-left: calc(-2px - var(--gap-x) * 0.5);
}`,
};
