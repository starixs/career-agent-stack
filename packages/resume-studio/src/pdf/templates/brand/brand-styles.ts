import type { Style } from "@react-pdf/types";
import type { ResumeData } from "../../../schema/resume/data";
import type { getTemplateMetrics } from "../shared/metrics";
import type { BrandHeader, BrandLine, BrandSectionDecoration, BrandStyle } from "./brands";
import { BRAND_HAIRLINE } from "./brands";

type Metrics = ReturnType<typeof getTemplateMetrics>;

export type BrandColors = { ink: string; text: string; muted: string; accent: string; accentLight: string };

/** 浅色强调底：主色在白底上约 12% 的不透明度，对应原 CSS 的 --accent-light。 */
export const BRAND_ACCENT_LIGHT_OPACITY = 0.12;

/** 标签栅格左列宽度（%），对应原 CSS 120–150px 在 A4 版心里的占比。 */
const LABEL_COLUMN_WIDTH = "22%";

/** 胶囊标题的圆角：足够大即成半圆端。 */
const PILL_RADIUS = 999;

export const lineColor = (line: BrandLine, colors: BrandColors): string =>
	({ ink: colors.ink, accent: colors.accent, "accent-light": colors.accentLight, hairline: BRAND_HAIRLINE })[line];

/** 页眉外框：五种处理各自只加边框 / 底色 / 对齐。 */
export const brandHeaderStyle = (header: BrandHeader, colors: BrandColors, metrics: Metrics): Style => {
	const row: Style = { flexDirection: "row", alignItems: "center", columnGap: metrics.gapX(1) };
	const pad = metrics.gapY(0.75);
	switch (header.kind) {
		case "plain":
			return row;
		case "underline":
			return { ...row, borderBottomWidth: header.width, borderBottomColor: lineColor(header.color, colors), paddingBottom: pad };
		case "left-bar":
			return { ...row, borderLeftWidth: header.width, borderLeftColor: colors.accent, paddingLeft: metrics.gapX(1) };
		case "top-rule":
			return {
				...row,
				borderTopWidth: header.width,
				borderTopColor: colors.ink,
				borderBottomWidth: 1,
				borderBottomColor: colors.ink,
				paddingVertical: pad,
			};
		case "panel":
			return {
				...row,
				backgroundColor: colors.accentLight,
				borderWidth: 1,
				borderColor: BRAND_HAIRLINE,
				borderRadius: header.radius,
				padding: metrics.gapX(1),
			};
		case "centered":
			return {
				flexDirection: "column",
				alignItems: "center",
				rowGap: metrics.gapY(0.5),
				borderBottomWidth: header.width,
				borderBottomColor: lineColor(header.color, colors),
				paddingBottom: pad,
			};
	}
};

/** 分节标题的装饰：下划线 / 左色条 / 顶线 / 胶囊 / 色带。 */
export const brandSectionDecorationStyle = (decoration: BrandSectionDecoration, colors: BrandColors, metrics: Metrics): Style => {
	switch (decoration.kind) {
		case "none":
			return {};
		case "underline":
			return { borderBottomWidth: decoration.width, borderBottomColor: lineColor(decoration.color, colors), paddingBottom: metrics.gapY(0.25) };
		case "left-bar":
			return { borderLeftWidth: decoration.width, borderLeftColor: colors.accent, paddingLeft: metrics.gapX(1 / 3) };
		case "top-rule":
			return { borderTopWidth: decoration.width, borderTopColor: colors.ink, paddingTop: metrics.gapY(0.35) };
		case "pill":
			return {
				alignSelf: "flex-start",
				backgroundColor: colors.accentLight,
				borderRadius: PILL_RADIUS,
				paddingHorizontal: metrics.gapX(0.5),
				paddingVertical: metrics.gapY(0.15),
			};
		case "band":
			return {
				backgroundColor: colors.accentLight,
				borderWidth: 1,
				borderColor: BRAND_HAIRLINE,
				paddingHorizontal: metrics.gapX(0.5),
				paddingVertical: metrics.gapY(0.2),
			};
	}
};

/** 分节外框与分节标题；标签栅格时分节横排、标题占左列。 */
export const brandSectionStyles = (
	brand: BrandStyle,
	colors: BrandColors,
	metrics: Metrics,
	metadata: ResumeData["metadata"],
	textAlign: NonNullable<Style["textAlign"]>,
): { section: Style; sectionHeading: Style; sectionItems: Style } => {
	const { section } = brand;
	const headingColor = section.color === "accent" ? colors.accent : section.color === "muted" ? colors.muted : colors.ink;
	const heading: Style = {
		fontSize: metadata.typography.heading.fontSize * section.scale,
		color: headingColor,
		letterSpacing: section.letterSpacing,
		textAlign,
		...(section.uppercase ? { textTransform: "uppercase" } : {}),
		...brandSectionDecorationStyle(section.decoration, colors, metrics),
	};
	if (!brand.labelGrid) {
		return { section: { flexDirection: "column", rowGap: metrics.gapY(0.4) }, sectionHeading: heading, sectionItems: {} };
	}
	return {
		section: {
			flexDirection: "row",
			columnGap: metrics.columnGap,
			borderTopWidth: 1,
			borderTopColor: BRAND_HAIRLINE,
			paddingTop: metrics.gapY(0.5),
		},
		sectionHeading: { ...heading, width: LABEL_COLUMN_WIDTH, flexShrink: 0 },
		sectionItems: { flex: 1 },
	};
};
