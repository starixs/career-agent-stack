/**
 * 富文本白名单清洗：简历描述来自用户和 AI，进 HTML 简历前只保留排版标签。
 * 不在白名单的元素去壳留字；属性一律丢弃，只有 <a> 保留 http(s)/mailto 的 href。
 */
import { type HTMLElement, type Node, NodeType, parse } from "node-html-parser";

const ALLOWED = new Set([
	"p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "code", "mark", "a", "h1", "h2", "h3", "blockquote", "hr",
]);
const VOID = new Set(["br", "hr"]);
const SAFE_HREF = /^(https?:|mailto:)/i;

export const escapeHtml = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decodeEntities = (text: string): string =>
	text
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");

function renderNode(node: Node): string {
	if (node.nodeType === NodeType.TEXT_NODE) return escapeHtml(decodeEntities(node.rawText));
	if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
	const el = node as HTMLElement;
	const tag = el.rawTagName?.toLowerCase() ?? "";
	const inner = el.childNodes.map(renderNode).join("");
	if (!ALLOWED.has(tag)) return inner;
	if (VOID.has(tag)) return `<${tag}>`;
	if (tag === "a") {
		const href = el.getAttribute("href")?.trim() ?? "";
		return SAFE_HREF.test(href) ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
	}
	return `<${tag}>${inner}</${tag}>`;
}

/** 清洗后的 HTML；空段落（编辑器常留的 <p></p>）去掉。 */
export function sanitizeRichText(html: string | undefined | null): string {
	if (!html?.trim()) return "";
	return parse(html).childNodes.map(renderNode).join("").replace(/<p>\s*<\/p>/g, "").trim();
}
