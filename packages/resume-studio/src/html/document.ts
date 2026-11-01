/**
 * ResumeData → 完整 HTML 文档（预览 iframe 与导出 Chrome 共用同一份）。
 * 版面尺寸用 pt / mm，与打印一致；缩放只动两个变量：--fs（字号）与 --sp（间距），见 fit.ts。
 */
import type { ResumeData } from "../schema/resume/data";
import type { HtmlTemplate } from "./templates";
import {
	getPdfFallbackFontFamilies,
	getRawWebFontSource,
	getWebFont,
	getWebFontSource,
	resolveBoldFontWeight,
	type FontWeight,
} from "../fonts";
import { filterSections } from "../pdf/templates/shared/filtering";
import { iconSvg } from "./icons";
import { escapeHtml as esc } from "./sanitize";
import { renderSection } from "./sections";
import { getHtmlTemplate } from "./templates";

/** 纸张尺寸（mm）。free-form 按 A4 宽排，高度不限。 */
export const PAGE_SIZE_MM = { a4: { width: 210, height: 297 }, letter: { width: 215.9, height: 279.4 } } as const;
export const PT_PER_MM = 72 / 25.4;

export type FontRequirement = { family: string; weight: FontWeight; url: string };

/**
 * 这份简历要加载的字体文件：正文 / 标题字体 + 中文等回退字体，各取常规与粗体。
 * raw=true 返回原始 CDN 地址（侧车导出按它拦截）；默认经改写器（渲染层改到侧车字体缓存）。
 */
export function requiredFonts(data: ResumeData, { raw = false }: { raw?: boolean } = {}): FontRequirement[] {
	const source = raw ? getRawWebFontSource : getWebFontSource;
	const t = data.metadata.typography;
	const seen = new Set<string>();
	const out: FontRequirement[] = [];
	for (const spec of [t.body, t.heading]) {
		const families = [spec.fontFamily, ...getPdfFallbackFontFamilies(spec.fontFamily, { locale: data.metadata.page.locale as never })];
		for (const family of families) {
			if (!getWebFont(family)) continue;
			const bold = resolveBoldFontWeight(family, spec.fontWeights) ?? "700";
			for (const weight of ["400", bold] as FontWeight[]) {
				const url = source(family, weight);
				const key = `${family}|${weight}`;
				if (url && !seen.has(key)) { seen.add(key); out.push({ family, weight, url }); }
			}
		}
	}
	return out;
}

const fontStack = (data: ResumeData, family: string) =>
	[family, ...getPdfFallbackFontFamilies(family, { locale: data.metadata.page.locale as never }), "sans-serif"]
		.map((f) => (f === "sans-serif" ? f : `"${f}"`))
		.join(", ");

export const fontFaceCss = (fonts: FontRequirement[]) =>
	fonts.map((f) => `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; src: url("${f.url}"); }`).join("\n");

function baseCss(data: ResumeData): string {
	const m = data.metadata;
	const size = PAGE_SIZE_MM[m.page.format === "letter" ? "letter" : "a4"];
	return `
@page { size: ${size.width}mm ${size.height}mm; margin: ${m.page.marginY}pt ${m.page.marginX}pt; }
:root {
  --fs: 1; --sp: 1;
  --primary: ${m.design.colors.primary}; --text: ${m.design.colors.text}; --ink: var(--text); --muted: color-mix(in srgb, var(--text) 62%, white);
  --bg: ${m.design.colors.background}; --accent-light: color-mix(in srgb, var(--primary) 12%, white);
  --body-size: calc(${m.typography.body.fontSize}pt * var(--fs)); --heading-size: calc(${m.typography.heading.fontSize}pt * var(--fs));
  --gap-x: calc(${m.page.gapX}pt * var(--sp)); --gap-y: calc(${m.page.gapY}pt * var(--sp));
  --margin-x: ${m.page.marginX}pt; --margin-y: calc(${m.page.marginY}pt * var(--sp));
  --sidebar-w: ${m.layout.sidebarWidth}%;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--bg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${fontStack(data, m.typography.body.fontFamily)}; font-size: var(--body-size); line-height: ${m.typography.body.lineHeight}; color: var(--text); background: var(--bg); line-break: strict; overflow-wrap: anywhere; }
.page { width: ${size.width}mm; padding: ${m.page.marginY}pt ${m.page.marginX}pt; background: var(--bg); }
@media screen { .page { min-height: ${size.height}mm; } }
@media print { .page { width: auto; padding: 0; } }
.content { display: flex; flex-direction: column; row-gap: var(--margin-y); }
.header { display: flex; align-items: center; column-gap: calc(var(--gap-x) * 3); row-gap: var(--gap-y); }
.identity { flex: 1; min-width: 0; display: flex; flex-direction: column; row-gap: calc(var(--gap-y) * 0.35); }
.name, .section-title, .primary { font-family: ${fontStack(data, m.typography.heading.fontFamily)}; color: var(--ink); }
.name { font-size: calc(var(--heading-size) * 1.5); line-height: 1.3; font-weight: 700; }
.contacts { display: flex; flex-wrap: wrap; column-gap: calc(var(--gap-x) * 3); row-gap: 2pt; }
a { color: inherit; text-decoration: ${m.page.hideLinkUnderline ? "none" : "underline"}; }
.columns { display: flex; flex-direction: column; row-gap: var(--margin-y); }
.columns.sidebar-left, .columns.sidebar-right { display: grid; grid-template-columns: var(--sidebar-w) 1fr; column-gap: var(--margin-x); align-items: start; }
.columns.sidebar-right { grid-template-columns: 1fr var(--sidebar-w); }
.columns.sidebar-right .sidebar { order: 2; }
.main, .sidebar { display: flex; flex-direction: column; row-gap: var(--margin-y); min-width: 0; }
.section-title { font-size: var(--heading-size); line-height: ${m.typography.heading.lineHeight}; font-weight: 600; margin-bottom: calc(var(--gap-y) * 0.5); break-after: avoid; }
.items { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); column-gap: calc(var(--gap-x) * 3); row-gap: var(--gap-y); }
.item { break-inside: avoid; display: flex; flex-direction: column; row-gap: 1pt; }
.row { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: calc(var(--gap-x) * 2); }
.primary { font-weight: 600; }
.aside { text-align: right; margin-left: auto; }
.secondary, .aside { color: var(--muted); }
.rich p + p, .rich ul, .rich ol { margin-top: 2pt; }
.rich ul, .rich ol, ul.keywords { padding-left: 1.2em; }
.rich li { orphans: 2; widows: 2; }
.roles { display: flex; flex-direction: column; row-gap: calc(var(--gap-y) * 0.6); margin-top: 2pt; }
.level { display: flex; gap: 3pt; margin-top: 2pt; }
.level i { display: block; width: 6pt; height: 6pt; border: 1px solid var(--primary); }
.level.dot i { border-radius: 50%; }
.level i.on { background: var(--primary); }
.level.bar { height: 4pt; border: 1px solid var(--primary); }
.level.bar i { height: 100%; border: 0; background: var(--primary); }
.photo { object-fit: ${data.picture.fit}; flex-shrink: 0; }
.icon { width: 1em; height: 1em; flex-shrink: 0; vertical-align: -0.125em; }
.contact { display: inline-flex; align-items: center; column-gap: 0.25em; }
.contact .icon { color: var(--primary); }
.section-title { display: flex; align-items: center; column-gap: 0.35em; }
.with-icon { display: inline-flex; align-items: center; column-gap: 0.3em; }
.item-icon { color: var(--primary); }
.level.icons { gap: 1pt; color: var(--primary); }
.level.icons span { opacity: 0.35; display: inline-flex; }
.level.icons span.on { opacity: 1; }
`;
}

function photo(data: ResumeData): string {
	const p = data.picture;
	if (p.hidden || !p.url) return "";
	return `<img class="photo" src="${esc(p.url)}" alt="" style="width:${p.size}pt;height:${p.size / p.aspectRatio}pt;border-radius:${p.borderRadius}pt;border:${p.borderWidth}pt solid ${p.borderColor};transform:rotate(${p.rotation}deg)">`;
}

function header(data: ResumeData, withPhoto: boolean): string {
	const b = data.basics;
	const ic = (name: string) => (data.metadata.page.hideIcons ? "" : iconSvg(name));
	const web = (url: string) => /^https?:/i.test(url);
	const contacts = [
		b.email && `<a class="contact" href="mailto:${esc(b.email)}">${ic("envelope")}${esc(b.email)}</a>`,
		b.phone && `<span class="contact">${ic("phone")}${esc(b.phone)}</span>`,
		b.location && `<span class="contact">${ic("map-pin")}${esc(b.location)}</span>`,
		b.website.url && web(b.website.url) && `<a class="contact" href="${esc(b.website.url)}">${ic("globe")}${esc(b.website.label || b.website.url)}</a>`,
		...b.customFields.map((f) => {
			if (!f.text) return "";
			const inner = `${ic(f.icon)}${esc(f.text)}`;
			return f.link && web(f.link) ? `<a class="contact" href="${esc(f.link)}">${inner}</a>` : `<span class="contact">${inner}</span>`;
		}),
	].filter(Boolean);
	return `<header class="header">${withPhoto ? photo(data) : ""}<div class="identity"><h1 class="name">${esc(b.name)}</h1>${b.headline ? `<div class="headline">${esc(b.headline)}</div>` : ""}<div class="contacts">${contacts.join("")}</div></div></header>`;
}

const interleave = (a: string[], b: string[]) =>
	Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [b[i], a[i]]).flat().filter((x): x is string => Boolean(x));

/** 一个版式页：首页带页眉（位置由模板定），后续页另起一页。 */
function layoutPage(data: ResumeData, t: HtmlTemplate, page: ResumeData["metadata"]["layout"]["pages"][number], first: boolean): string {
	const render = (ids: string[]) => filterSections(ids, data).map((id) => renderSection(id, data));
	const main = render(page.main);
	const side = page.fullWidth ? [] : render(page.sidebar);
	const brk = first ? "" : ' style="break-before: page"';
	const twoCol = (t.layout === "sidebar-left" || t.layout === "sidebar-right") && side.length > 0;
	const sidePhoto = first && t.photo === "sidebar" && twoCol ? photo(data) : "";
	const head = first ? header(data, !sidePhoto) : "";
	const at = twoCol ? (t.header ?? "top") : "top";
	if (!twoCol) {
		const body = t.layout === "interleave" ? interleave(main, side) : [...main, ...side];
		return `${head}<div class="columns"${brk}><div class="main">${body.join("")}</div></div>`;
	}
	const aside = `<aside class="sidebar">${sidePhoto}${at === "sidebar" ? head : ""}${side.join("")}</aside>`;
	const mainCol = `<div class="main">${at === "main" ? head : ""}${main.join("")}</div>`;
	return `${at === "top" ? head : ""}<div class="columns ${t.layout}"${brk}>${aside}${mainCol}</div>`;
}

const columns = (data: ResumeData, t: HtmlTemplate) =>
	data.metadata.layout.pages.map((page, index) => layoutPage(data, t, page, index === 0)).join("");

export type BuildHtmlOptions = { fontCss?: string };

/** 返回完整 HTML；模板没有 HTML 版时返回 null（迁移期由调用方回落到 react-pdf）。 */
export function buildResumeHtml(data: ResumeData, options: BuildHtmlOptions = {}): string | null {
	const template = getHtmlTemplate(data.metadata.template);
	if (!template) return null;
	const lang = esc(data.metadata.page.locale || "zh-CN");
	return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${options.fontCss ?? ""}${baseCss(data)}${template.css}</style></head><body data-template="${esc(data.metadata.template)}"><div class="page"><div class="content">${columns(data, template)}</div></div></body></html>`;
}
