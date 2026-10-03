// 冒烟：用 15 套模板把示例简历（改成中文内容）渲染成 PDF，检查能出页、中文字形能嵌入。
// 用法：npx tsx scripts/render-smoke.mts [模板名…]   输出到 $TMPDIR/resume-studio-smoke/
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sampleResumeData, templateSchema, type ResumeData } from '../src/schema/index';
import { createResumePdfFile } from '../src/pdf/server';

const out = join(tmpdir(), 'resume-studio-smoke');
mkdirSync(out, { recursive: true });

const data: ResumeData = structuredClone(sampleResumeData);
data.basics.name = '张三';
data.basics.headline = '后端开发工程师 · 2026 届';
data.summary.content = '<p>熟悉 Java / Go 与分布式系统，主导过日均千万级请求的推荐召回服务重构，延迟降低 40%。</p>';
data.metadata.page.locale = 'zh-CN';

const names = process.argv.slice(2).length ? process.argv.slice(2) : templateSchema.options;
for (const template of names) {
  const t0 = Date.now();
  try {
    const file = await createResumePdfFile({ data, filename: `${template}.pdf`, template: template as never });
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(out, `${template}.pdf`), buf);
    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const cjkFont = /NotoSansSC|Noto Sans SC|NotoSerifSC/.test(buf.toString('latin1'));
    console.log(`✓ ${template.padEnd(10)} ${pages} 页 ${(buf.length / 1024).toFixed(0)}KB 中文字体:${cjkFont ? '有' : '无'} ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`✗ ${template}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`输出：${out}`);
