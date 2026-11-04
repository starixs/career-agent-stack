import { describe, expect, it } from "vitest";
import { BRAND_TEMPLATES } from "../pdf/templates/brand/brands";
import { sampleResumeData } from "../schema/resume/sample";
import { templateSchema } from "../schema/templates";
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
		// 自然高 940 不满一页；间距拉到上限 1.5 倍会到 1000（超过 970），所以只调间距就够
		const measure = fakeMeasure(820, 120);
		const s = await fitOnePage(measure, 1000);
		expect(s.font).toBe(1);
		expect(s.space).toBeLessThan(MAX_SPACE);
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

	it.each([...templateSchema.options])("%s 生成完整文档并含各分区", (template) => {
		const html = buildResumeHtml(withTemplate(template));
		expect(html).toContain("<!doctype html>");
		expect(html).toContain(`data-template="${template}"`);
		expect(html).toContain('data-section="experience"');
		expect(html).toContain(sampleResumeData.basics.name);
	});

	it("所有模板都有 HTML 版（迁移完成，不再回落 react-pdf）", () => {
		const missing = templateSchema.options.filter((t) => buildResumeHtml(withTemplate(t)) === null);
		expect(missing).toEqual([]);
	});

	it("页边距只由 .page 内边距承担：@page 页边距为 0，屏幕与打印同一套几何", () => {
		for (const t of templateSchema.options) {
			const html = buildResumeHtml(withTemplate(t)) ?? "";
			expect(html, t).toMatch(/@page \{ size: [\d.]+mm [\d.]+mm; margin: 0; \}/);
			expect(html, t).not.toMatch(/@page\s*(:first\s*)?\{[^}]*margin-(top|left|right|bottom)/);
		}
	});

	it("技能横排成「分组：关键词」，不输出熟练度、等级和条目图标", () => {
		const data = withTemplate("onyx");
		data.metadata.page.locale = "zh-CN";
		data.sections.skills.items = [
			{ ...data.sections.skills.items[0]!, name: "编程语言", proficiency: "熟练", level: 4, keywords: ["Go", "Java"] },
		];
		const html = buildResumeHtml(data) ?? "";
		// 只看条目区（分区标题图标由「显示分区图标」决定，不在本条范围）
		const start = html.indexOf('<div class="items', html.indexOf('data-section="skills"'));
		const skills = html.slice(start, html.indexOf("</section>", start));
		expect(skills).toContain('class="items compact"');
		expect(skills).toContain("编程语言</span><span class=\"kw\">：Go、Java</span>");
		expect(skills).not.toContain("熟练");
		expect(skills).not.toContain('class="level');
		expect(skills).not.toContain("<svg");
	});

	it("奖项无描述时横排成短语，有描述的单独一行展开", () => {
		const data = withTemplate("onyx");
		const base = data.sections.awards.items[0]!;
		data.sections.awards.hidden = false;
		data.sections.awards.items = [
			{ ...base, id: "a1", title: "校级一等奖学金", awarder: "", date: "2024.10", description: "" },
			{ ...base, id: "a2", title: "ACM 区域赛银牌", awarder: "", date: "2023.11", description: "<p>队长，负责图论</p>" },
		];
		const html = buildResumeHtml(data) ?? "";
		expect(html).toMatch(/<div class="item"><span class="primary">校级一等奖学金<\/span><span class="note">2024\.10<\/span><\/div>/);
		expect(html).toMatch(/<div class="item block">.*ACM 区域赛银牌.*队长，负责图论/);
	});

	it("姓名等纯文本字段转义，不能注入标签", () => {
		const data = withTemplate("onyx");
		data.basics.name = '<img src=x onerror="alert(1)">';
		const html = buildResumeHtml(data) ?? "";
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
