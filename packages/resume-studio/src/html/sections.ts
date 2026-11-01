/**
 * 各分区渲染成 HTML 片段。结构固定、类名语义化，外观全部交给模板 CSS：
 *   section.section[data-section] > h2.section-title + .items > .item
 *   .item > .item-head(.row > .primary/.secondary/.aside) + .rich
 */
import type { ResumeData, SectionItem, SectionType } from "../schema/resume/data";
import { getResumeSectionIcon } from "../pdf/section-icon";
import { getResumeSectionTitle } from "../pdf/section-title";
import { iconSvg } from "./icons";
import { filterItems } from "../pdf/templates/shared/filtering";
import { escapeHtml as esc, sanitizeRichText } from "./sanitize";

type Ctx = { data: ResumeData };
type Website = { url: string; label: string };

/** 技能 / 语言等级的格数上限，对应 schema 里 level 的 0–5。 */
const LEVEL_MAX = 5;

const rich = (html: string) => {
	const clean = sanitizeRichText(html);
	return clean ? `<div class="rich">${clean}</div>` : "";
};
const link = (w: Website | undefined) =>
	w?.url && /^https?:/i.test(w.url) ? `<a class="link" href="${esc(w.url)}">${esc(w.label || w.url)}</a>` : "";
const span = (cls: string, text: string | undefined) => (text?.trim() ? `<span class="${cls}">${esc(text)}</span>` : "");
const row = (...cells: string[]) => (cells.some(Boolean) ? `<div class="row">${cells.join("")}</div>` : "");
const head = (...rows: string[]) => `<div class="item-head">${rows.join("")}</div>`;
const item = (...parts: string[]) => `<div class="item">${parts.join("")}</div>`;
const keywords = (list: string[], layout: "inline" | "list" = "inline") => {
	const words = list.filter((k) => k.trim());
	if (!words.length) return "";
	if (layout === "list") return `<ul class="keywords">${words.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>`;
	return `<div class="keywords">${esc(words.join(", "))}</div>`;
};

function level(value: number, ctx: Ctx): string {
	const { type, icon } = ctx.data.metadata.design.level;
	if (type === "hidden" || value <= 0) return "";
	if (type === "icon") {
		const svg = iconSvg(icon);
		if (!svg) return "";
		return `<div class="level icons">${Array.from({ length: LEVEL_MAX }, (_, i) => `<span class="${i < value ? "on" : ""}">${svg}</span>`).join("")}</div>`;
	}
	if (type === "progress-bar") return `<div class="level bar"><i style="width:${(value / LEVEL_MAX) * 100}%"></i></div>`;
	const shape = type === "circle" ? "dot" : "box";
	const cells = Array.from({ length: LEVEL_MAX }, (_, i) => `<i class="${i < value ? "on" : ""}"></i>`).join("");
	return `<div class="level ${shape}">${cells}</div>`;
}

/** 条目图标（技能 / 社交账号 / 兴趣），「隐藏图标」开时不画。 */
const itemIcon = (ctx: Ctx, name: string, color: string) => {
	if (ctx.data.metadata.page.hideIcons || !name) return "";
	const svg = iconSvg(name, "icon item-icon");
	return svg && color ? svg.replace("<svg ", `<svg style="color:${esc(color)}" `) : svg;
};
const titled = (icon: string, text: string) => (icon ? `<span class="primary with-icon">${icon}${esc(text)}</span>` : span("primary", text));

const RENDERERS: { [K in SectionType]: (it: SectionItem<K>, ctx: Ctx, layout?: "inline" | "list") => string } = {
	experience: (it) => {
		const roles = it.roles.map((r) => item(head(row(span("secondary", r.position), span("aside", r.period))), rich(r.description)));
		return item(
			head(row(span("primary", it.company), span("aside", it.location)), row(span("secondary", it.position), span("aside", it.period))),
			rich(it.description),
			roles.length ? `<div class="roles">${roles.join("")}</div>` : "",
		);
	},
	education: (it) =>
		item(
			head(
				row(span("primary", it.school), span("aside", [it.degree, it.grade].filter(Boolean).join(" · "))),
				row(span("secondary", it.area), span("aside", [it.location, it.period].filter(Boolean).join(" · "))),
			),
			rich(it.description),
		),
	projects: (it) => item(head(row(span("primary", it.name), span("aside", it.period)), row(link(it.website))), rich(it.description)),
	skills: (it, ctx, layout) =>
		item(head(row(titled(itemIcon(ctx, it.icon, it.iconColor), it.name), span("aside", it.proficiency))), level(it.level, ctx), keywords(it.keywords, layout)),
	languages: (it, ctx) => item(head(row(span("primary", it.language), span("aside", it.fluency))), level(it.level, ctx)),
	interests: (it, ctx) => item(head(row(titled(itemIcon(ctx, it.icon, it.iconColor), it.name))), keywords(it.keywords)),
	profiles: (it, ctx) =>
		item(
			head(
				row(titled(itemIcon(ctx, it.icon, it.iconColor), it.network)),
				row(it.website.url ? link({ url: it.website.url, label: it.username || it.website.label }) : span("secondary", it.username)),
			),
		),
	awards: (it) => item(head(row(span("primary", it.title), span("aside", it.date)), row(span("secondary", it.awarder), link(it.website))), rich(it.description)),
	certifications: (it) => item(head(row(span("primary", it.title), span("aside", it.date)), row(span("secondary", it.issuer), link(it.website))), rich(it.description)),
	publications: (it) => item(head(row(span("primary", it.title), span("aside", it.date)), row(span("secondary", it.publisher), link(it.website))), rich(it.description)),
	volunteer: (it) => item(head(row(span("primary", it.organization), span("aside", it.location)), row(link(it.website), span("aside", it.period))), rich(it.description)),
	references: (it) => item(head(row(span("primary", it.name), span("aside", it.phone)), row(span("secondary", it.position), link(it.website))), rich(it.description)),
};

const shell = (ctx: Ctx, id: string, type: string, title: string, showHeading: boolean, columns: number, body: string) => {
	const icon = ctx.data.metadata.page.hideSectionIcons ? "" : iconSvg(getResumeSectionIcon(ctx.data, id), "icon section-icon");
	const heading = showHeading ? `<h2 class="section-title">${icon}${esc(getResumeSectionTitle(ctx.data, id, title))}</h2>` : "";
	return `<section class="section" data-section="${esc(type)}" data-id="${esc(id)}">${heading}<div class="items" style="--cols:${Math.max(1, columns)}">${body}</div></section>`;
};

function renderStandard(type: SectionType, ctx: Ctx): string {
	const section = ctx.data.sections[type];
	const items = filterItems(section.items as SectionItem[], type) as SectionItem<typeof type>[];
	const render = RENDERERS[type] as (it: SectionItem, ctx: Ctx, layout?: "inline" | "list") => string;
	const layout = type === "skills" ? ctx.data.sections.skills.keywordLayout : undefined;
	return shell(ctx, type, type, section.title, section.showHeading !== false, section.columns, items.map((it) => render(it, ctx, layout)).join(""));
}

function renderCustom(id: string, ctx: Ctx): string {
	const section = ctx.data.customSections.find((s) => s.id === id);
	if (!section || section.type === "cover-letter") return "";
	const items = filterItems(section.items, section.type);
	let body: string;
	if (section.type === "summary") {
		body = items.map((it) => item(rich("content" in it && typeof it.content === "string" ? it.content : ""))).join("");
	} else {
		// 自定义分区的条目形状由 section.type 决定（schema 的判别联合），这里按类型取对应渲染器
		const render = RENDERERS[section.type] as (it: unknown, ctx: Ctx) => string;
		body = items.map((it) => render(it, ctx)).join("");
	}
	return shell(ctx, id, section.type, section.title, section.showHeading !== false, section.columns, body);
}

export function renderSection(id: string, data: ResumeData): string {
	const ctx = { data };
	if (id === "summary") {
		const s = data.summary;
		return shell(ctx, "summary", "summary", s.title, s.showHeading !== false, s.columns, item(rich(s.content)));
	}
	if (id in data.sections) return renderStandard(id as SectionType, ctx);
	return renderCustom(id, ctx);
}
