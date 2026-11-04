/**
 * Phosphor 图标 → 内联 SVG。图标数据沿用现有依赖 phosphor-icons-react-pdf：调用它的组件得到
 * react-pdf 基本元素树（SVG / PATH / CIRCLE …，type 为大写字符串），原样转成 SVG 标记。
 * 不新增依赖；第三段删 react-pdf 时可换成 @phosphor-icons/core 的原始 SVG，接口不变。
 */
import { icons } from "phosphor-icons-react-pdf/dynamic";
import { escapeHtml as esc } from "./sanitize";

type Element = { type: unknown; props: Record<string, unknown> };
/** 展开函数组件的层数上限：dynamic → 权重分派 → regular 组件，正常 2–3 层。 */
const MAX_DEPTH = 6;

const isElement = (v: unknown): v is Element => typeof v === "object" && v !== null && "type" in v && "props" in v;
/** SVG 里这几个属性名本身就是驼峰，不能转成短横线。 */
const CAMEL_ATTRS = new Set(["viewBox", "preserveAspectRatio", "gradientTransform", "gradientUnits"]);
const kebab = (k: string) => (CAMEL_ATTRS.has(k) ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

function expand(el: Element): Element | null {
	let cur: Element = el;
	for (let i = 0; i < MAX_DEPTH && typeof cur.type === "function"; i++) {
		const next: unknown = (cur.type as (p: Record<string, unknown>) => unknown)(cur.props);
		if (!isElement(next)) return null;
		cur = next;
	}
	return typeof cur.type === "string" ? cur : null;
}

function toMarkup(el: Element): string {
	const tag = String(el.type).toLowerCase();
	const attrs = Object.entries(el.props)
		.filter(([k, v]) => k !== "children" && k !== "style" && (typeof v === "string" || typeof v === "number"))
		.map(([k, v]) => ` ${kebab(k)}="${esc(String(v))}"`)
		.join("");
	const kids = ([] as unknown[]).concat(el.props.children ?? []).filter(isElement).map((c) => {
		const expanded = expand(c);
		return expanded ? toMarkup(expanded) : "";
	});
	return `<${tag}${attrs}>${kids.join("")}</${tag}>`;
}

const cache = new Map<string, string>();

/** 图标的 SVG 标记；名字不存在返回空串。尺寸 1em、颜色 currentColor，由 CSS 控制。 */
export function iconSvg(name: string, className = "icon"): string {
	if (!name) return "";
	const key = `${name}|${className}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const component = (icons as Record<string, unknown>)[name];
	const root = typeof component === "function" ? expand({ type: component, props: { size: "1em", color: "currentColor" } }) : null;
	const svg = root ? toMarkup(root).replace(/^<svg/, `<svg class="${esc(className)}" aria-hidden="true"`) : "";
	cache.set(key, svg);
	return svg;
}
