/**
 * 大厂设计语言风格的简历模板族：12 套风格共用一个页面组件，差异全部收在这份配置里。
 *
 * 来源：Cliccker/brand-style-resume（MIT），把它 assets/styles/*.css 里的配色、页眉处理、
 * 分节标题处理和标签栅格翻译成 react-pdf 参数。这些是对各公司公开设计系统的独立改编，
 * 不是官方模板，也不代表任何公司的招聘偏好；不含商标、字体和截图。
 *
 * 主色取用户的 design.colors.primary（版式面板点选品牌时会顺手设成 `accent`，之后仍可改），
 * 浅色强调底从主色推出；文字三级灰按品牌固定。
 */

export const BRAND_TEMPLATES = [
	"apple",
	"material",
	"fluent",
	"carbon",
	"antd",
	"tdesign",
	"arco",
	"semi",
	"harmony",
	"baidu",
	"spectrum",
	"lightning",
] as const;

export type BrandTemplate = (typeof BRAND_TEMPLATES)[number];

/** 页眉处理：下划线 / 左竖条 / 顶粗线 / 浅色底板 / 居中。 */
export type BrandHeader =
	| { kind: "plain" }
	| { kind: "underline"; width: number; color: BrandLine }
	| { kind: "left-bar"; width: number }
	| { kind: "top-rule"; width: number }
	| { kind: "panel"; radius: number }
	| { kind: "centered"; width: number; color: BrandLine };

/** 分节标题处理。 */
export type BrandSectionDecoration =
	| { kind: "none" }
	| { kind: "underline"; width: number; color: BrandLine }
	| { kind: "left-bar"; width: number }
	| { kind: "top-rule"; width: number }
	| { kind: "pill" }
	| { kind: "band" };

/** 线条颜色取哪一级：品牌墨色 / 主色 / 浅色强调底 / 淡分隔线。 */
export type BrandLine = "ink" | "accent" | "accent-light" | "hairline";

export type BrandStyle = {
	label: string;
	/** 品牌强调色，点选模板时写进 design.colors.primary。 */
	accent: string;
	palette: { ink: string; text: string; muted: string };
	header: BrandHeader;
	/** 姓名字号相对 heading.fontSize 的倍数，和字重。 */
	name: { scale: number; weight: "400" | "500" | "600" | "700" };
	section: {
		/** 字号相对 heading.fontSize 的倍数。 */
		scale: number;
		color: "ink" | "accent" | "muted";
		uppercase: boolean;
		letterSpacing: number;
		decoration: BrandSectionDecoration;
	};
	/** 标签栅格：分节标题放左列（IBM Carbon、百度 DLS）。 */
	labelGrid: boolean;
	pictureRadius: number;
};

/** 分隔线的淡灰：原 CSS 的 rgba(0,0,0,.10) 在白底上的等效色。 */
export const BRAND_HAIRLINE = "#E5E5E5";

export const BRAND_STYLES: Record<BrandTemplate, BrandStyle> = {
	apple: {
		label: "Apple · 留白克制",
		accent: "#0071E3",
		palette: { ink: "#1D1D1F", text: "#525252", muted: "#86868B" },
		header: { kind: "plain" },
		name: { scale: 1.75, weight: "700" },
		section: { scale: 0.75, color: "muted", uppercase: true, letterSpacing: 1.5, decoration: { kind: "underline", width: 0.75, color: "hairline" } },
		labelGrid: false,
		pictureRadius: 16,
	},
	material: {
		label: "Material 3 · 胶囊标题",
		accent: "#6750A4",
		palette: { ink: "#1D1B20", text: "#49454F", muted: "#625B71" },
		header: { kind: "underline", width: 3, color: "accent-light" },
		name: { scale: 1.75, weight: "500" },
		section: { scale: 0.85, color: "accent", uppercase: false, letterSpacing: 0, decoration: { kind: "pill" } },
		labelGrid: false,
		pictureRadius: 20,
	},
	fluent: {
		label: "Fluent 2 · 左竖条页眉",
		accent: "#0F6CBD",
		palette: { ink: "#242424", text: "#424242", muted: "#616161" },
		header: { kind: "left-bar", width: 4 },
		name: { scale: 1.6, weight: "600" },
		section: { scale: 0.9, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "underline", width: 1, color: "hairline" } },
		labelGrid: false,
		pictureRadius: 8,
	},
	carbon: {
		label: "IBM Carbon · 左列标签",
		accent: "#0F62FE",
		palette: { ink: "#161616", text: "#525252", muted: "#6F6F6F" },
		header: { kind: "top-rule", width: 4 },
		name: { scale: 2, weight: "400" },
		section: { scale: 0.75, color: "ink", uppercase: true, letterSpacing: 0.8, decoration: { kind: "none" } },
		labelGrid: true,
		pictureRadius: 0,
	},
	antd: {
		label: "Ant Design · 色条标题",
		accent: "#1677FF",
		palette: { ink: "#141414", text: "#434343", muted: "#595959" },
		header: { kind: "underline", width: 2, color: "accent" },
		name: { scale: 1.6, weight: "600" },
		section: { scale: 0.9, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "left-bar", width: 3 } },
		labelGrid: false,
		pictureRadius: 6,
	},
	tdesign: {
		label: "腾讯 TDesign · 蓝色标题",
		accent: "#0052D9",
		palette: { ink: "#181818", text: "#444444", muted: "#666666" },
		header: { kind: "underline", width: 1, color: "hairline" },
		name: { scale: 1.6, weight: "600" },
		section: { scale: 0.9, color: "accent", uppercase: false, letterSpacing: 0, decoration: { kind: "underline", width: 2, color: "accent-light" } },
		labelGrid: false,
		pictureRadius: 10,
	},
	arco: {
		label: "字节 Arco · 粗顶线",
		accent: "#165DFF",
		palette: { ink: "#1D2129", text: "#4E5969", muted: "#6B7785" },
		header: { kind: "left-bar", width: 8 },
		name: { scale: 1.6, weight: "700" },
		section: { scale: 0.8, color: "ink", uppercase: true, letterSpacing: 0.8, decoration: { kind: "top-rule", width: 2 } },
		labelGrid: false,
		pictureRadius: 4,
	},
	semi: {
		label: "抖音 Semi · 大标题",
		accent: "#0064FA",
		palette: { ink: "#1C1F23", text: "#41464D", muted: "#626973" },
		header: { kind: "plain" },
		name: { scale: 1.6, weight: "700" },
		section: { scale: 1.05, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "none" } },
		labelGrid: false,
		pictureRadius: 12,
	},
	harmony: {
		label: "鸿蒙 HarmonyOS · 居中",
		accent: "#0A59F7",
		palette: { ink: "#182431", text: "#42505E", muted: "#596775" },
		header: { kind: "centered", width: 2, color: "accent-light" },
		name: { scale: 1.6, weight: "600" },
		section: { scale: 0.95, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "none" } },
		labelGrid: false,
		pictureRadius: 24,
	},
	baidu: {
		label: "百度 DLS · 左列标签",
		accent: "#2B65D9",
		palette: { ink: "#191C22", text: "#454C59", muted: "#626B7A" },
		header: { kind: "underline", width: 3, color: "accent" },
		name: { scale: 1.6, weight: "600" },
		section: { scale: 0.85, color: "accent", uppercase: false, letterSpacing: 0, decoration: { kind: "none" } },
		labelGrid: true,
		pictureRadius: 4,
	},
	spectrum: {
		label: "Adobe Spectrum · 黑线大字",
		accent: "#1473E6",
		palette: { ink: "#222222", text: "#464646", muted: "#626262" },
		header: { kind: "underline", width: 2, color: "ink" },
		name: { scale: 2.1, weight: "700" },
		section: { scale: 1.05, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "underline", width: 1, color: "ink" } },
		labelGrid: false,
		pictureRadius: 4,
	},
	lightning: {
		label: "Salesforce Lightning · 色带",
		accent: "#0176D3",
		palette: { ink: "#181818", text: "#444444", muted: "#626262" },
		header: { kind: "panel", radius: 8 },
		name: { scale: 1.6, weight: "700" },
		section: { scale: 0.9, color: "ink", uppercase: false, letterSpacing: 0, decoration: { kind: "band" } },
		labelGrid: false,
		pictureRadius: 8,
	},
};

export const isBrandTemplate = (template: string): template is BrandTemplate =>
	(BRAND_TEMPLATES as readonly string[]).includes(template);
