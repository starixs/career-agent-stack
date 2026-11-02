// HTML 排版引擎入口：预览（渲染层 iframe）与导出（侧车 Chrome 打印）共用。
export { buildResumeHtml, fontFaceCss, PAGE_SIZE_MM, requiredFonts } from "./document";
export type { BuildHtmlOptions, FontRequirement } from "./document";
export { applyAndMeasure, fitOnePage, FILL_TARGET, MAX_FONT, MAX_SPACE, MEASURE_SNIPPET, MIN_FONT, paperHeightPx } from "./fit";
export type { FitScales, Measure } from "./fit";
export { sanitizeRichText } from "./sanitize";
export { hasHtmlTemplate } from "./templates";
