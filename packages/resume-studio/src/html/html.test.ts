import { describe, expect, it } from "vitest";
import { BRAND_TEMPLATES } from "../pdf/templates/brand/brands";
import { sampleResumeData } from "../schema/resume/sample";
import { buildResumeHtml } from "./document";
import { FILL_TARGET, fitOnePage, MAX_FONT, MAX_SPACE, MIN_FONT, type FitScales } from "./fit";
import { sanitizeRichText } from "./sanitize";

/** 假测量：高度 = 字号部分 × font + 间距部分 × space（近似真实排版的单调关系）。 */
const fakeMeasure = (text: number, gaps: number) => (s: FitScales) => text * s.font + gaps * s.space;

describe("fitOnePage", () => {
	it("略超一页时字号与间距一起缩，刚好排进一页", async () => {
		const measure = fakeMeasure(800, 300);
		const s = await fitOnePage(measure, 1000);
		expect(s.font).toBe(s.space);
		expect(s.font).toBeLessThan(1);
		expect(measure(s)).toBeLessThanOrEqual(1000 * FILL_TARGET);
		expect(measure(s)).toBeGreaterThan(1000 * FILL_TARGET * 0.99);
	});

	it("缩到最小仍放不下就保持原样，让内容正常分页", async () => {
		expect(await fitOnePage(fakeMeasure(1500, 400), 1000)).toEqual({ font: 1, space: 1 });
	});

	it("不满一页时先拉开间距，不动字号", async () => {
		const measure = fakeMeasure(700, 150);
		const s = await fitOnePage(measure, 1000);
		expect(s.font).toBe(1);
		expect(s.space).toBeGreaterThan(1);
		expect(measure(s)).toBeLessThanOrEqual(1000 * FILL_TARGET);
	});

	it("间距拉满还不够才放大字号，且不超过上限", async () => {
		const s = await fitOnePage(fakeMeasure(300, 50), 1000);
		expect(s.space).toBe(MAX_SPACE);
		expect(s.font).toBeLessThanOrEqual(MAX_FONT);
		expect(MIN_FONT).toBeLessThan(1);
	});
});

describe("sanitizeRichText", () => {
	it("只留排版标签：脚本、事件属性和 javascript 链接都去掉", () => {
		const out = sanitizeRichText(
			'<p onclick="x()">做了<strong>A</strong><script>alert(1)</script></p><a href="javascript:alert(1)">坏</a><a href="https://ok.example">好</a><img src=x onerror=y>',
		);
		expect(out).toBe('<p>做了<strong>A</strong>alert(1)</p>坏<a href="https://ok.example">好</a>');
	});

	it("空段落去掉，实体正确转义", () => {
		expect(sanitizeRichText("<p></p><p>a &lt; b &amp; c</p>")).toBe("<p>a &lt; b &amp; c</p>");
	});
});

describe("buildResumeHtml", () => {
	const withTemplate = (template: string) => {
		const data = structuredClone(sampleResumeData);
		data.metadata.template = template as typeof data.metadata.template;
		return data;
	};

	it.each(["onyx", "azurill", ...BRAND_TEMPLATES])("%s 生成完整文档并含各分区", (template) => {
		const html = buildResumeHtml(withTemplate(template));
		expect(html).toContain("<!doctype html>");
		expect(html).toContain(`data-template="${template}"`);
		expect(html).toContain('data-section="experience"');
		expect(html).toContain(sampleResumeData.basics.name);
	});

	it("还没有 HTML 版的模板返回 null（迁移期回落 react-pdf）", () => {
		expect(buildResumeHtml(withTemplate("pikachu"))).toBeNull();
	});

	it("姓名等纯文本字段转义，不能注入标签", () => {
		const data = withTemplate("onyx");
		data.basics.name = '<img src=x onerror="alert(1)">';
		const html = buildResumeHtml(data) ?? "";
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
