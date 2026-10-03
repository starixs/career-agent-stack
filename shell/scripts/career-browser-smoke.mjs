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
  basics: { name: '张三', phone: '13800138000', email: 'zhangsan@example.com', school: '某某大学', major: '计算机科学', degree: '硕士', graduation: '2027.06', city: '上海', wechat: 'zs_wx' },
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
  hasContext: () => !!context,
  getControl: () => ({ control: 'agent', reason: null, since: Date.now() }),
  setControl: () => ({ control: 'agent', reason: null, since: Date.now() }),
  browserChannel: () => 'chrome',
  // 现场直播路由（免令牌借用）
  withProductSession: async (_id, fn) => { if (!context) throw new Error('no context'); return fn(context); },
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
  // 日期字段没有 placeholder 时统一整形成 YYYY-MM（资料里写的是 2020.09 / 2027.06）
  check(rows.edu[1]?.[1] === '软件工程' && rows.edu[1]?.[2] === '本科' && rows.edu[1]?.[3] === '2020-09', `第 2 行专业 / 学历 / 入学时间（已整形）：${JSON.stringify(rows.edu[1])}`);
  check(rows.edu[0]?.[4] === '2027-06', `第 1 行毕业时间来自教育经历而不是实习（已整形）：${rows.edu[0]?.[4]}`);
  check(rows.exp.length === 2 && rows.exp[0]?.[0] === 'A 公司' && rows.exp[1]?.[0] === 'B 公司' && rows.exp[1]?.[1] === '数据实习生', `实习经历两行：${JSON.stringify(rows.exp)}`);
  const sections = r?.pages?.[0]?.sections ?? [];
  check(sections.some(s => s.key === 'education' && s.added === 1) && sections.some(s => s.key === 'experience' && s.added === 1), `分区摘要：${JSON.stringify(sections)}`);
  check(!(await page.evaluate(() => !!document.getElementById('done'))), '没有提交');
}

if (only === 'all' || only === 'widgets') {
  console.log('\n[5] 第三方控件（antd 风格非搜索下拉 / element 风格日期校验 / React 风格受控输入）→ 页内执行器');
  const r = await run({ op: 'drive', url: fixture('apply-form-widgets.html'), humanTyping: false, settleMs: 300, maxPages: 1 });
  check(r?.status === 'stopped_before_submit', `status=${r?.status} message=${r?.message}`);
  const page = context.pages()[0];
  const values = await page.evaluate(() => window.__values());
  check(values.name === '张三', `姓名=${values.name}`);
  check(values.degree === '硕士研究生', `antd 下拉按字典归一点选：degree=${values.degree}（资料写的是"硕士"）`);
  check(values.grad === '2027/06', `日期按 placeholder 整形并通过失焦校验：grad=${values.grad}`);
  check(values.phone === '13800138000', `受控输入：phone=${values.phone}`);
  check((r?.mismatches ?? []).length === 0, `差异核对：${JSON.stringify(r?.mismatches ?? [])}`);
  check(!(await page.evaluate(() => !!document.getElementById('done'))), '没有提交');
  console.log(`  escalations=${JSON.stringify(r?.escalations)} layersUsed=${JSON.stringify(r?.layersUsed)}`);
}

if (only === 'all' || only === 'live') {
  console.log('\n[4] 浏览器现场直播（CDP screencast → NDJSON 帧）');
  if (!context) { await host.withContext(TOKEN, async () => {}); await context.newPage().then(p => p.goto(fixture('apply-form.html'))); }
  const { handleCareerLiveRoute } = await import('../src/server/routes/career-live.ts');
  const { LiveHub } = await import('../src/server/career/live-hub.ts');
  const hub = new LiveHub();
  const controller = new AbortController();
  const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=1', { signal: controller.signal }), {
    host, hub, repos: { openHandoffs: () => [], getAction: () => undefined, closeHandoff: () => {}, kvSet: () => {} }, productSessionId: () => 'smoke', heartbeatMs: 1000,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = ''; let frames = 0; let snapshot = null; let firstFrame = null;
  // 让页面持续有变化（真实场景是助理在填表），触发新帧；4 秒后断开连接
  const poke = setInterval(() => { context.pages()[0].evaluate(() => { window.scrollBy(0, 40); document.body.style.background = `hsl(${Date.now() % 360},40%,95%)`; }).catch(() => {}); }, 300);
  const deadline = setTimeout(() => controller.abort(), 4000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'snapshot') snapshot = ev;
        if (ev.type === 'frame') { frames++; firstFrame ??= ev; }
        if (ev.type === 'frame-error') console.log(`  ✗ frame-error: ${ev.error}`);
      }
      if (frames >= 5) controller.abort();
    }
  } catch { /* abort */ }
  clearInterval(poke); clearTimeout(deadline);
  check(!!snapshot && snapshot.browser.hasBrowser, `snapshot：hasBrowser=${snapshot?.browser?.hasBrowser} url=${snapshot?.browser?.url}`);
  check(frames >= 1, `收到 ${frames} 帧`);
  check(!!firstFrame && firstFrame.data.length > 1000 && firstFrame.width > 0, `首帧 ${firstFrame?.width}x${firstFrame?.height}，JPEG base64 ${firstFrame?.data?.length ?? 0} 字节`);
  check(hub.size === 0, '断开后 hub 订阅清空');
}

if (only === 'all' || only === 'embedded') {
  console.log('\n[5] 内嵌窗口：真实 Chrome 停在角落，仍能截图 / 出帧 / 接收输入；选文件框被拦下改由产品内上传');
  const { compileBrowserRuntimeSettings } = await import('../src/server/browser-host/runtime-settings.ts');
  const { parkWindow } = await import('../src/server/browser-host/page-control.ts');
  const { FileChooserBroker } = await import('../src/server/career/file-chooser.ts');
  const { LiveHub } = await import('../src/server/career/live-hub.ts');
  const compiled = compileBrowserRuntimeSettings('smoke-embedded', process.cwd(), { persistentProfile: true, systemChrome: true, mirrorIdentity: false, profileRoot: tmpdir(), embeddedWindow: true });
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'career-embedded-')), { ...compiled.launchOptions, ...compiled.contextOptions });
  try {
    const hub = new LiveHub();
    const broker = new FileChooserBroker(hub);
    const page = ctx.pages()[0] ?? await ctx.newPage();
    page.on('filechooser', chooser => { void broker.offer('smoke', chooser); });
    await page.setContent('<button id=b style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="document.title=\'clicked\'">点我</button><input id=f type=file accept=".pdf" style="position:absolute;left:100px;top:300px"><div id=t></div><script>setInterval(()=>t.textContent=Date.now(),100)</script>');
    check(await parkWindow(ctx, page), '窗口停到角落');
    const cdp = await ctx.newCDPSession(page);
    const { bounds } = await cdp.send('Browser.getWindowForTarget');
    check(bounds.left < 0 || bounds.top > 400, `窗口位置 left=${bounds.left} top=${bounds.top} ${bounds.width}x${bounds.height}`);
    const vis = await page.evaluate(() => [innerWidth, innerHeight, document.visibilityState]);
    check(vis[0] === 1366 && vis[2] === 'visible', `视口仍是 ${vis[0]}x${vis[1]}，visibility=${vis[2]}`);
    const shot = await page.screenshot({ timeout: 8000 }).catch(() => null);
    check(!!shot && shot.length > 1000, `停靠状态下截图 ${shot?.length ?? 0} 字节（视觉层依赖）`);
    let frames = 0;
    cdp.on('Page.screencastFrame', ev => { frames++; void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}); });
    await cdp.send('Page.enable'); await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50 });
    await new Promise(r => setTimeout(r, 1500));
    await cdp.send('Page.stopScreencast');
    check(frames > 0, `停靠状态下 screencast ${frames} 帧`);
    await page.mouse.click(150, 120);
    check(await page.title() === 'clicked', '坐标点击生效');
    let opened = null;
    hub.subscribe(ev => { if (ev.type === 'career:live-filechooser' && ev.state === 'open') opened = ev; });
    await page.mouse.click(150, 310);
    for (let i = 0; i < 30 && !opened; i++) await new Promise(r => setTimeout(r, 100));
    check(!!opened && opened.accept === '.pdf', `选文件框被拦下：accept=${opened?.accept}`);
    if (opened) {
      await broker.fulfill(opened.id, [{ name: '简历.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 smoke').toString('base64') }]);
      const picked = await page.evaluate(() => { const f = document.getElementById('f').files[0]; return f ? `${f.name}:${f.size}` : null; });
      check(picked === '简历.pdf:14', `产品内上传交给页面：${picked}`);
    }
  } finally {
    await ctx.close();
  }
}

await browser?.close();
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
