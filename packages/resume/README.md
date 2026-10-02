# @career/resume

简历领域库：结构化简历（中国求职场景）、JD 九类分析、按经历库主张定制（JSON Patch + 理由 + 编造检测）、投递邮件 / 短投递语、PDF / DOCX / PNG 导出，以及基于 `@career/core` 仓储的 `ResumeService`。

## 用法

```ts
import { parseJd, tailorResume, fitToPages, renderPdf, renderDocx, renderPng, ResumeService } from '@career/resume'
const jd = await parseJd(llm, jdRaw, { candidate: svc.candidateText(masterId) })
const { proposed, patch, rationale, truthfulnessFlags } = await tailorResume(llm, { master, jd, claims, strength: 'keywords' })
const pdf = await renderPdf(fitToPages(proposed, 1).resume)       // A4 单页 ClassicCN
const png = await renderPng(pdf, { scale: 2 })                       // 首页 PNG
```

- 定制只用 `verified` / `user_confirmed` 的主张；改动以 RFC 6902 Patch 返回，每条附理由；新文本里的数字 / 拉丁名词若不在 master 或主张里出现会进 `truthfulnessFlags`（`rejectFlagged: true` 直接丢弃）。
- `ResumeService.tailorAndStore` 把结果以"未确认"落库，用户确认后调 `confirmTailored`。

## 字体与渲染

PDF：西文用内置 Times-Roman/Times-Bold，中文用 `@fontsource/noto-sans-sc` 的 woff 子集（按文本用到的码点按需注册，`fontFamily` 数组逐字回退）。中文换行由 `render/measure.ts` 按 AFM / 1em 度量预先插入换行并处理行首禁则（react-pdf 自身只在空格分词，且断字处会画连字符）。DOCX：宋体 + Times New Roman，Word 原生项目符号。PNG：pdfjs-dist + @napi-rs/canvas。

## 未实测 / 已知限制

- 中文字体是 Noto Sans（黑体风格），不是宋体；`basics.photo_url` 在 DOCX 里只支持本地文件。
- 编造检测不识别中文数字与中文专有名词；`estimateLines` 是估算，一页铁律以 `pdfPageCount` 为准。
- 只有一套 PDF 模板 `ClassicCN`；未在 Windows 上验证 DOCX 字体回退。
