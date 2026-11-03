import type { TemplateSemanticManifest } from "../../semantic/template-manifest";
import type { BrandTemplate } from "./brands";
import { itemHeaderRowPart } from "../../semantic/shared-parts";
import { BRAND_TEMPLATES } from "./brands";

/** 品牌模板单栏顺排：main 区域先收主栏分区、再收侧栏分区（不写 flow 即顺排）。 */
const brandSemanticManifest = (template: BrandTemplate): TemplateSemanticManifest => ({
	template,
	regions: [
		{ name: "header", placement: "main", origins: [] },
		{ name: "main", placement: "main", origins: ["main", "sidebar"] },
	],
	header: { region: "header", placement: "main" },
	specialSummary: null,
	parts: [itemHeaderRowPart],
});

export const brandSemanticManifests = Object.fromEntries(
	BRAND_TEMPLATES.map((template) => [template, brandSemanticManifest(template)]),
) as Record<BrandTemplate, TemplateSemanticManifest>;
