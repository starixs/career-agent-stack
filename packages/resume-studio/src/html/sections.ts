/**
 * 各分区渲染成 HTML 片段。结构固定、类名语义化，外观全部交给模板 CSS：
 *   section.section[data-section] > h2.section-title + .items > .item
 *   .item > .item-head(.row > .primary/.secondary/.aside) + .rich
 *
 * 技能 / 语言 / 兴趣 / 奖项 / 证书是「紧凑分区」（.items.compact）：每条一行短语、横向排开、排满换行。
 * 熟练度文字、等级星点、条目图标不画——对 HR 是无效信息、还占版面（用户反馈 11-04）。
 * 奖项 / 证书带描述的条目仍单独占一行（.item.block）。
 */
import type { ResumeData, SectionItem, SectionType } from "../schema/resume/data";
import { getResumeSectionIcon } from "../pdf/section-icon";
import { getResumeSectionTitle } from "../pdf/section-title";
import { filterItems } from "../pdf/templates/shared/filtering";
import { iconSvg } from "./icons";
import { escapeHtml as esc, sanitizeRichText } from "./sanitize";

type Ctx = { data: ResumeData };
type Website = { url: string; label: string };
type Render = (it: SectionItem, ctx: Ctx) => string;

/** 横向排开的分区类型。 */
const COMPACT_TYPES = new Set<string>(["skills", "languages", "interests", "awards", "certifications"]);

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

/** 中文简历用顿号 / 全角冒号，其余用逗号 / 半角冒号。 */
const isCjk = (ctx: Ctx) => /^(zh|ja|ko)/i.test(ctx.data.metadata.page.locale);
const joinWords = (ctx: Ctx, list: string[]) => list.filter((k) => k.trim()).join(isCjk(ctx) ? "、" : ", ");

/** 紧凑条目：「名称：关键词、关键词」或「名称（补充）」，一条一个短语。 */
function phrase(ctx: Ctx, name: string, words: string, note = ""): string {
	const colon = isCjk(ctx) ? "：" : ": ";
	const tail = words ? `<span class="kw">${colon}${esc(words)}</span>` : note ? span("note", note) : "";
	return `<div class="item">${span("primary", name)}${tail}</div>`;
}

/** 奖项 / 证书：短条目横排；有描述的单独一行照常展开。 */
function award(ctx: Ctx, title: string, by: string, date: string, website: Website, description: string): string {
	const body = rich(description);
	if (!body) {
		const extra = [by, date].filter((s) => s.trim()).join(isCjk(ctx) ? "，" : ", ");
		return `<div class="item">${span("primary", title)}${extra ? span("note", extra) : ""}</div>`;
	}
	return `<div class="item block">${head(row(span("primary", title), span("aside", date)), row(span("secondary", by), link(website)))}${body}</div>`;
}

/** 条目图标（社交账号），「隐藏图标」开时不画。 */
const itemIcon = (ctx: Ctx, name: string, color: string) => {
	if (ctx.data.metadata.page.hideIcons || !name) return "";
	const svg = iconSvg(name, "icon item-icon");
	return svg && color ? svg.replace("<svg ", `<svg style="color:${esc(color)}" `) : svg;
};
const titled = (icon: string, text: string) => (icon ? `<span class="primary with-icon">${icon}${esc(text)}</span>` : span("primary", text));

const RENDERERS: { [K in SectionType]: (it: SectionItem<K>, ctx: Ctx) => string } = {
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
	skills: (it, ctx) => phrase(ctx, it.name, joinWords(ctx, it.keywords)),
	languages: (it, ctx) => phrase(ctx, it.language, "", it.fluency),
	interests: (it, ctx) => phrase(ctx, it.name, joinWords(ctx, it.keywords)),
	profiles: (it, ctx) =>
		item(
			head(
				row(titled(itemIcon(ctx, it.icon, it.iconColor), it.network)),
				row(it.website.url ? link({ url: it.website.url, label: it.username || it.website.label }) : span("secondary", it.username)),
			),
		),
	awards: (it, ctx) => award(ctx, it.title, it.awarder, it.date, it.website, it.description),
	certifications: (it, ctx) => award(ctx, it.title, it.issuer, it.date, it.website, it.description),
	publications: (it) => item(head(row(span("primary", it.title), span("aside", it.date)), row(span("secondary", it.publisher), link(it.website))), rich(it.description)),
	volunteer: (it) => item(head(row(span("primary", it.organization), span("aside", it.location)), row(link(it.website), span("aside", it.period))), rich(it.description)),
	references: (it) => item(head(row(span("primary", it.name), span("aside", it.phone)), row(span("secondary", it.position), link(it.website))), rich(it.description)),
};

const shell = (ctx: Ctx, id: string, type: string, title: string, showHeading: boolean, columns: number, body: string) => {
	const icon = ctx.data.metadata.page.hideSectionIcons ? "" : iconSvg(getResumeSectionIcon(ctx.data, id), "icon section-icon");
	const heading = showHeading ? `<h2 class="section-title">${icon}${esc(getResumeSectionTitle(ctx.data, id, title))}</h2>` : "";
	const cls = COMPACT_TYPES.has(type) ? "items compact" : "items";
	return `<section class="section" data-section="${esc(type)}" data-id="${esc(id)}">${heading}<div class="${cls}" style="--cols:${Math.max(1, columns)}">${body}</div></section>`;
};

function renderStandard(type: SectionType, ctx: Ctx): string {
	const section = ctx.data.sections[type];
	const items = filterItems(section.items as SectionItem[], type);
	const render = RENDERERS[type] as Render;
	return shell(ctx, type, type, section.title, section.showHeading !== false, section.columns, items.map((it) => render(it, ctx)).join(""));
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
