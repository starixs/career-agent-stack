#!/usr/bin/env node
// 托管浏览器执行链路冒烟：不依赖 Tauri / Rust 能力令牌，用假 host + 本机 Chrome（无头）直接打
// `/api/career/browser/run` 的 drive 操作，验证 路由 → @career/apply 引擎 → 真实 Chrome 这条链。
//
//   node --import tsx/esm scripts/career-browser-smoke.mjs            # 两个用例：普通表单（DOM 层）、closed shadow DOM（视觉兜底层）
//   node --import tsx/esm scripts/career-browser-smoke.mjs --case=shadow --headed
//   CAREER_VISION_OCR=0 ...                                            # 关掉 OCR（只验证 DOM 层）
//
// 先 `pnpm -C ../ -r build`（引擎走 packages/apply/dist）。模型用桩：开放题起草返回空，不需要 API key。
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const only = (argv.find(a => a.startsWith('--case=')) ?? '--case=all').slice(7);

const { handleCareerBrowserRoute } = await import('../src/server/routes/career-browser.ts');
const apply = await import(pathToFileURL(join(here, '..', '..', 'packages', 'apply', 'dist', 'index.js')).href);

const TOKEN = 'a'.repeat(32);
const stubLlm = {
  supportsImages: () => false,
  complete: async () => ({ text: JSON.stringify({ answers: [] }), usage: { input_tokens: 0, output_tokens: 0 } }),
};
const profile = {
  basics: { name: '张三', phone: '13800138000', email: 'zhangsan@example.com', school: '某某大学', major: '计算机科学', degree: '硕士', city: '上海', wechat: 'zs_wx' },
  experiences: [
    { title: '推荐系统重构', org: 'A 公司', role: '算法实习生', period: '2025.03~2025.08', claims: ['把离线特征计算从 6h 压到 40min'] },
    { title: '数据平台', org: 'B 公司', role: '数据实习生', period: '2024.07~2024.09', claims: ['搭建埋点报表'] },
  ],
  education: [
    { school: '某某大学', major: '计算机科学', degree: '硕士', start: '2024.09', end: '2027.06' },
    { school: '某某学院', major: '软件工程', degree: '本科', start: '2020.09', end: '2024.06' },
  ],
  answerBank: [{ question_key: '期望薪资', question_text: '期望薪资', answer: '15k-18k', high_impact: true, confirmed: true }],
};

let browser = null;
let context = null;
const host = {
  verifyCapability: async () => ({ productSessionId: 'smoke', workspacePath: mkdtempSync(join(tmpdir(), 'career-smoke-')), hostGeneration: 1 }),
  withContext: async (_token, fn) => {
    if (!browser) {
      browser = await chromium.launch({ channel: 'chrome', headless: !headed });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    }
    return fn(context, { productSessionId: 'smoke', workspacePath: '', hostGeneration: 1 });
  },
  hasContext: () => true,
  getControl: () => ({ control: 'agent', reason: null, since: Date.now() }),
  setControl: () => ({ control: 'agent', reason: null, since: Date.now() }),
  browserChannel: () => 'chrome',
};
const deps = {
  host,
  loadApply: async () => apply,
  resolveLlm: async () => stubLlm,
  resolveDriveProfile: async () => ({ profile, redact: v => v }),
};

async function run(body) {
  const request = new Request('http://local/api/career/browser/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  const response = await handleCareerBrowserRoute('/api/career/browser/run', request, deps);
  const text = await response.text();
  const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const l of lines) {
    if (l.type === 'progress') console.log(`  · ${l.message}`);
    if (l.type === 'error') console.log(`  ✗ error ${l.status}: ${l.error}`);
  }
  return lines.find(l => l.type === 'result')?.result ?? null;
}

const fixture = name => pathToFileURL(join(here, 'fixtures', name)).href;
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };

if (only === 'all' || only === 'form') {
  console.log('\n[1] 普通表单（DOM 直驱，两页，停在提交前）');
  const r = await run({ op: 'drive', url: fixture('apply-form.html'), humanTyping: false, settleMs: 300 });
  check(r?.status === 'stopped_before_submit', `status=${r?.status} message=${r?.message}`);
  check(r?.pages?.length === 2, `走了 ${r?.pages?.length} 页；第 1 页按钮「${r?.pages?.[0]?.nextButton}」`);
  const filled = Object.fromEntries((r?.filled ?? []).map(f => [f.label, f.value]));
  check(filled['姓名'] === '张三' && filled['手机号'] === '13800138000' && filled['邮箱'] === 'zhangsan@example.com', `基本信息：${JSON.stringify(filled)}`);
  check(filled['最高学历'] === '硕士', `下拉选择：${filled['最高学历']}`);
  check(filled['期望薪资'] === '15k-18k', `高影响项用答案库原话：${filled['期望薪资']}`);
  check((r?.drafts ?? []).length + (r?.needsUser ?? []).length >= 1, `开放题「自我评价」没有草稿 → needs_user/drafts：${(r?.needsUser ?? []).map(n => n.label).join('、') || (r?.drafts ?? []).map(d => d.label).join('、')}`);
  check(r?.submitButton === '提交申请', `停在「${r?.submitButton}」前，未提交`);
  check((r?.mismatches ?? []).length === 0, `差异核对：${(r?.mismatches ?? []).length} 处不一致`);
  const page = context.pages()[0];
  check(!(await page.evaluate(() => !!document.getElementById('done'))), '页面没有出现"提交成功"');
  console.log(`  layersUsed=${JSON.stringify(r?.layersUsed)} escalations=${JSON.stringify(r?.escalations)}`);
}

if (only === 'all' || only === 'shadow') {
  console.log('\n[2] closed shadow DOM 自绘表单（DOM 看不见 → 截图 OCR + 坐标点击 + 键盘输入）');
  const r = await run({ op: 'drive', url: fixture('apply-form-shadow.html'), humanTyping: false, settleMs: 300, maxPages: 1 });
  check(!!r, `有结果：status=${r?.status} message=${r?.message}`);
  check((r?.layersUsed ?? []).includes('vision'), `用到了视觉层：${JSON.stringify(r?.layersUsed)}`);
  const page = context.pages()[0];
  const values = await page.evaluate(() => (window.__values ? window.__values() : null));
  check(values?.name === '张三', `姓名（shadow 内真实值）=${values?.name}`);
  check(values?.phone === '13800138000', `手机号=${values?.phone}`);
  check(values?.email === 'zhangsan@example.com', `邮箱=${values?.email}`);
  check(values?.school === '某某大学', `毕业院校=${values?.school}`);
  check(r?.status === 'stopped_before_submit' && /提交/.test(r?.submitButton ?? ''), `停在提交前：submitButton=${r?.submitButton}`);
  check(!(await page.evaluate(() => !!window.__submitted)), '没有点提交');
  console.log(`  escalations=${JSON.stringify(r?.escalations)}`);
}

if (only === 'all' || only === 'sections') {
  console.log('\n[3] 教育 / 实习经历"表格"（两段 → 点"添加"再填新行）');
  const r = await run({ op: 'drive', url: fixture('apply-form-sections.html'), humanTyping: false, settleMs: 300, maxPages: 1 });
  check(r?.status === 'stopped_before_submit', `status=${r?.status} message=${r?.message}`);
  const page = context.pages()[0];
  const rows = await page.evaluate(() => window.__rows());
  check(rows.edu.length === 2 && rows.edu[0]?.[0] === '某某大学' && rows.edu[1]?.[0] === '某某学院', `教育经历两行：${JSON.stringify(rows.edu)}`);
  check(rows.edu[1]?.[1] === '软件工程' && rows.edu[1]?.[2] === '本科' && rows.edu[1]?.[3] === '2020.09', `第 2 行专业 / 学历 / 入学时间：${JSON.stringify(rows.edu[1])}`);
  check(rows.edu[0]?.[4] === '2027.06', `第 1 行毕业时间来自教育经历而不是实习：${rows.edu[0]?.[4]}`);
  check(rows.exp.length === 2 && rows.exp[0]?.[0] === 'A 公司' && rows.exp[1]?.[0] === 'B 公司' && rows.exp[1]?.[1] === '数据实习生', `实习经历两行：${JSON.stringify(rows.exp)}`);
  const sections = r?.pages?.[0]?.sections ?? [];
  check(sections.some(s => s.key === 'education' && s.added === 1) && sections.some(s => s.key === 'experience' && s.added === 1), `分区摘要：${JSON.stringify(sections)}`);
  check(!(await page.evaluate(() => !!document.getElementById('done'))), '没有提交');
}

await browser?.close();
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
