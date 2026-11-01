/**
 * HTML 模板：每个模板 = 栏位结构 + 一段 CSS。CSS 只用 document.ts 注入的变量
 * （--primary / --text / --accent-light / --gap-y 等），所以缩放与配色对所有模板统一生效。
 *
 * 迁移期：没有 HTML 版的模板仍走 react-pdf（hasHtmlTemplate 为 false）。
 */
import type { Template } from "../schema/templates";
import type { BrandHeader, BrandLine, BrandSectionDecoration, BrandStyle } from "../pdf/templates/brand/brands";
import { BRAND_HAIRLINE, BRAND_STYLES, isBrandTemplate } from "../pdf/templates/brand/brands";

export type HtmlLayout = "stack" | "sidebar-left" | "sidebar-right";
export type HtmlTemplate = { layout: HtmlLayout; css: string };

const ONYX: HtmlTemplate = {
	layout: "stack",
	css: `
.header { border-bottom: 1px solid var(--primary); padding-bottom: var(--margin-y); }
.section-title { color: var(--primary); }`,
};

const AZURILL: HtmlTemplate = {
	layout: "sidebar-left",
	css: `
.header { flex-direction: column; text-align: center; }
.header .contacts { justify-content: center; }
.section-title { color: var(--primary); }
.main .items { position: relative; padding-left: 16px; }
.main .items::before { content: ""; position: absolute; left: 4px; top: 4px; bottom: 4px; width: 1px; background: var(--primary); }
.main .item { position: relative; }
.main .item::before { content: ""; position: absolute; left: -16px; top: 0.45em; width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--primary); background: var(--bg); }
.main .roles .item::before { display: none; }`,
};

const line = (l: BrandLine) =>
	({ ink: "var(--ink)", accent: "var(--primary)", "accent-light": "var(--accent-light)", hairline: BRAND_HAIRLINE })[l];

function brandHeaderCss(h: BrandHeader): string {
	switch (h.kind) {
		case "plain":
			return "";
		case "underline":
			return `.header { border-bottom: ${h.width}px solid ${line(h.color)}; padding-bottom: calc(var(--gap-y) * 1.2); }`;
		case "left-bar":
			return `.header { border-left: ${h.width}px solid var(--primary); padding-left: var(--margin-x); }`;
		case "top-rule":
			return `.header { border-top: ${h.width}px solid var(--ink); border-bottom: 1px solid var(--ink); padding: calc(var(--gap-y) * 1.2) 0; }`;
		case "panel":
			return `.header { background: var(--accent-light); border: 1px solid ${BRAND_HAIRLINE}; border-radius: ${h.radius}px; padding: var(--margin-x); }`;
		case "centered":
			return `.header { flex-direction: column; text-align: center; border-bottom: ${h.width}px solid ${line(h.color)}; padding-bottom: calc(var(--gap-y) * 1.2); } .header .contacts { justify-content: center; }`;
	}
}

function brandSectionCss(d: BrandSectionDecoration): string {
	switch (d.kind) {
		case "none":
			return "";
		case "underline":
			return `.section-title { border-bottom: ${d.width}px solid ${line(d.color)}; padding-bottom: calc(var(--gap-y) * 0.3); }`;
		case "left-bar":
			return `.section-title { border-left: ${d.width}px solid var(--primary); padding-left: 6px; }`;
		case "top-rule":
			return `.section-title { border-top: ${d.width}px solid var(--ink); padding-top: calc(var(--gap-y) * 0.4); }`;
		case "pill":
			return `.section-title { display: inline-block; background: var(--accent-light); border-radius: 999px; padding: 1px 10px; }`;
		case "band":
			return `.section-title { background: var(--accent-light); border: 1px solid ${BRAND_HAIRLINE}; padding: 2px 8px; }`;
	}
}

function brandTemplate(b: BrandStyle): HtmlTemplate {
	const s = b.section;
	const titleColor = s.color === "accent" ? "var(--primary)" : s.color === "muted" ? "var(--muted)" : "var(--ink)";
	const grid = b.labelGrid
		? `.section { display: grid; grid-template-columns: 22% 1fr; column-gap: var(--margin-x); border-top: 1px solid ${BRAND_HAIRLINE}; padding-top: calc(var(--gap-y) * 0.6); }`
		: "";
	return {
		layout: "stack",
		css: `
:root { --ink: ${b.palette.ink}; --text: ${b.palette.text}; --muted: ${b.palette.muted}; }
.name { font-size: calc(var(--heading-size) * ${b.name.scale}); font-weight: ${b.name.weight}; }
.photo { border-radius: ${b.pictureRadius}px; }
.section-title { font-size: calc(var(--heading-size) * ${s.scale}); color: ${titleColor}; letter-spacing: ${s.letterSpacing}px; ${s.uppercase ? "text-transform: uppercase;" : ""} }
${brandHeaderCss(b.header)}
${brandSectionCss(s.decoration)}
${grid}`,
	};
}

const CLASSIC: Partial<Record<Template, HtmlTemplate>> = { onyx: ONYX, azurill: AZURILL };

export function getHtmlTemplate(template: Template): HtmlTemplate | undefined {
	if (isBrandTemplate(template)) return brandTemplate(BRAND_STYLES[template]);
	return CLASSIC[template];
}

export const hasHtmlTemplate = (template: Template): boolean => getHtmlTemplate(template) !== undefined;
