import type { Style } from "@react-pdf/types";
import type { TemplatePage, TemplatePageProps } from "../../document";
import type { TemplateColorRoles, TemplateStyleSlots } from "../shared/types";
import type { BrandColors } from "./brand-styles";
import type { BrandStyle, BrandTemplate } from "./brands";
import { useMemo } from "react";
import { Page, StyleSheet } from "@react-pdf/renderer";
import { useRender } from "../../context";
import { useRenderedSectionIds, useResolvedNode } from "../../semantic/context";
import { semanticNodeKeys } from "../../semantic/node-keys";
import { getPrimaryTint } from "../shared/color-helpers";
import { TemplateProvider } from "../shared/context";
import { filterSections } from "../shared/filtering";
import { getTemplateMetrics } from "../shared/metrics";
import { SemanticRegionView } from "../shared/primitives";
import { Section } from "../shared/sections";
import { composeStyles, headerNameLineHeight } from "../shared/styles";
import { createIconSlot, TemplateHeader, useTemplateBase } from "../shared/template-base";
import { BRAND_ACCENT_LIGHT_OPACITY, brandHeaderStyle, brandSectionStyles } from "./brand-styles";
import { BRAND_STYLES } from "./brands";

type BrandStyles = Omit<TemplateStyleSlots, "page"> & {
	page: Style;
	header: Style;
	picture: Style;
	headerTitle: Style;
	headerIdentity: Style;
	headerName: Style;
	contactList: Style;
	contactItem: Style;
	sections: Style;
};

type BrandTemplateStyles = { colors: TemplateColorRoles; styles: BrandStyles };

/** 品牌模板都是单栏：侧栏分区接在主栏之后顺排（语义清单里 main 区域 origins 为 main、sidebar）。 */
export const createBrandPage = (template: BrandTemplate): TemplatePage => {
	const brand = BRAND_STYLES[template];

	const BrandPage = ({ page, pageSize, pageMinHeightStyle, showHeader, pageNumber }: TemplatePageProps) => {
		const data = useRender();
		const pageNodeKey = semanticNodeKeys.page(pageNumber);
		const { style: semanticPageStyle, size: semanticPageSize, ...semanticPageProps } = useResolvedNode(pageNodeKey);
		const { styles, colors } = useBrandTemplate(brand);
		const metrics = getTemplateMetrics(data.metadata.page);
		const mainSections = useRenderedSectionIds(pageNodeKey, filterSections(page.main, data));
		const sidebarSections = useRenderedSectionIds(pageNodeKey, filterSections(page.fullWidth ? [] : page.sidebar, data));

		return (
			<Page
				{...semanticPageProps}
				size={semanticPageSize ?? pageSize}
				style={composeStyles(styles.page, pageMinHeightStyle, semanticPageStyle)}
			>
				<TemplateProvider pageNodeKey={pageNodeKey} styles={styles} colors={colors}>
					{showHeader && <BrandHeaderView styles={styles} />}
					<SemanticRegionView region="main" style={composeStyles(styles.sections, { rowGap: metrics.sectionGap })}>
						{[...mainSections, ...sidebarSections].map((section) => (
							<Section key={section} section={section} placement="main" />
						))}
					</SemanticRegionView>
				</TemplateProvider>
			</Page>
		);
	};
	BrandPage.displayName = `BrandPage(${template})`;
	return BrandPage;
};

const BrandHeaderView = ({ styles }: { styles: BrandStyles }) => (
	<TemplateHeader
		styles={{
			header: styles.header,
			picture: styles.picture,
			title: styles.headerTitle,
			identity: styles.headerIdentity,
			name: styles.headerName,
			contactList: styles.contactList,
			contactItem: styles.contactItem,
		}}
	/>
);

const useBrandTemplate = (brand: BrandStyle): BrandTemplateStyles => {
	const templateBase = useTemplateBase();

	return useMemo(() => buildBrandStyles(brand, templateBase), [brand, templateBase]);
};

const buildBrandStyles = (brand: BrandStyle, templateBase: ReturnType<typeof useTemplateBase>): BrandTemplateStyles => {
	const { metadata, r, background, primary, metrics, base } = templateBase;
	const brandColors: BrandColors = {
		...brand.palette,
		accent: primary,
		accentLight: getPrimaryTint(primary, BRAND_ACCENT_LIGHT_OPACITY),
	};
	const colors: TemplateColorRoles = { foreground: brand.palette.text, background, primary };
	const centered = brand.header.kind === "centered";
	const header = brandHeaderStyle(brand.header, brandColors, metrics);

	const styles = StyleSheet.create({
		...base,
		...brandTextStyles(base, brandColors),
		...brandSectionStyles(brand, brandColors, metrics, metadata, r.sectionHeadingTextAlign),
		page: {
			...base.page,
			color: brand.palette.text,
			flexDirection: "column",
			rowGap: metrics.headerGap,
			paddingHorizontal: metrics.page.paddingHorizontal,
			paddingVertical: metrics.page.paddingVertical,
		},
		sections: { flexDirection: "column" },
		header: centered ? header : { ...header, flexDirection: r.row },
		picture: { ...base.picture, borderRadius: brand.pictureRadius },
		// 居中页眉是竖排：标题区不能 flex（flex-basis 0 会把高度压没），改占满宽度。
		headerTitle: centered
			? { width: "100%", alignItems: "center", rowGap: metrics.gapY(0.5) }
			: { flex: 1, rowGap: metrics.gapY(0.5) },
		headerIdentity: centered
			? { alignItems: "center", textAlign: "center", rowGap: metrics.gapY(0.35) }
			: { ...r.headerIdentity, rowGap: metrics.gapY(0.35) },
		headerName: {
			fontSize: metadata.typography.heading.fontSize * brand.name.scale,
			fontWeight: brand.name.weight,
			lineHeight: headerNameLineHeight,
			color: brand.palette.ink,
		},
		contactList: {
			flexDirection: r.row,
			flexWrap: "wrap",
			rowGap: metrics.gapY(0.125),
			columnGap: metrics.gapX(0.75),
			...(centered ? { justifyContent: "center" } : {}),
		},
		contactItem: { flexDirection: r.row, alignItems: "center", columnGap: metrics.gapX(1 / 6) },
		levelItem: { borderColor: primary },
		levelItemActive: { backgroundColor: primary },
	});

	return { colors, styles: { ...styles, icon: createIconSlot({ metadata, accentFor: (context) => context.colors.primary }) } };
};

/** 文字层级：标题和加粗用品牌墨色，正文用品牌正文灰，小字用次级灰。 */
const brandTextStyles = (base: ReturnType<typeof useTemplateBase>["base"], colors: BrandColors) => ({
	text: { ...base.text, color: colors.text },
	richParagraph: { ...base.richParagraph, color: colors.text },
	richListItemMarker: { ...base.richListItemMarker, color: colors.muted },
	richListItemContent: { ...base.richListItemContent, color: colors.text },
	heading: { ...base.heading, color: colors.ink },
	bold: { ...base.bold, color: colors.ink },
	link: { ...base.link, color: colors.text },
	small: { ...base.small, color: colors.muted },
});
