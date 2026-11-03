import { describe, expect, it } from "vitest";
import { sampleResumeData } from "../../../schema/resume/sample";
import { templateSchema } from "../../../schema/templates";
import { getTemplateSemanticManifest } from "../../semantic/template-manifest";
import { createResumePdfFile } from "../../server";
import { templatePages } from "../index";
import { BRAND_STYLES, BRAND_TEMPLATES } from "./brands";

describe("大厂风格模板族", () => {
	it("每套都登记进模板枚举、页面映射和语义清单", () => {
		for (const template of BRAND_TEMPLATES) {
			expect(templateSchema.options).toContain(template);
			expect(templatePages[template], template).toBeDefined();
			expect(getTemplateSemanticManifest(template).template).toBe(template);
			expect(BRAND_STYLES[template].accent).toMatch(/^#[0-9A-F]{6}$/i);
		}
	});

	it.each(BRAND_TEMPLATES)("%s 能渲染出非空 PDF", async (template) => {
		const data = structuredClone(sampleResumeData);
		data.picture.hidden = true;
		data.metadata.template = template;
		const file = await createResumePdfFile({ data, filename: `${template}.pdf`, template });
		const pdf = Buffer.from(await file.arrayBuffer()).toString("latin1");
		expect(pdf.startsWith("%PDF")).toBe(true);
		expect(pdf.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0).toBeGreaterThan(0);
	});
});
