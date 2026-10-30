// 真实 Chrome 冒烟：模型浏览工具（career/browse.ts）在本地页面上走一遍。
// 运行：cd app/shell && node --import tsx/esm scripts/career-browse-smoke.mjs [--headed]
// 覆盖：观察编号、点链接跳转、点击开新标签、搜索框输入 + 回车、提交类按钮被拦、密码框拒绝明文、旧观察编号被拒。
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browse = await import('../src/server/career/browse.ts');
const { isSubmitText } = await import('@career/apply');

const pages = {
  '/': `<html><head><title>岗位列表</title></head><body><main>
    <h1>校招岗位</h1>
    <form onsubmit="event.preventDefault(); document.getElementById('r').textContent='搜索：'+document.getElementById('q').value"><input id="q" placeholder="搜索岗位"></form>
    <div id="r"></div>
    <ul><li><a href="/job/1">AI 应用开发工程师 · 上海</a></li><li><a href="/job/2" target="_blank">数据分析师 · 杭州</a></li></ul>
    <p>${'这里是很长的岗位列表说明。'.repeat(20)}</p>
  </main></body></html>`,
  '/job/1': `<html><head><title>AI 应用开发工程师</title></head><body><main>
    <h1>AI 应用开发工程师</h1><p>岗位职责：负责大模型应用开发，搭建智能体工作流。任职要求：2027 届本科及以上，熟悉 Python。</p>
    <button id="apply">立即投递</button>
    <label>密码 <input type="password" id="pw"></label>
  </main></body></html>`,
  // 头部容器叫 .content（美团、腾讯校招页实测如此），岗位列表在它外面
  '/campus': `<html><head><title>校园招聘</title></head><body><div class="header"><div class="content"><a href="/">首页</a> <a href="/campus">校园招聘</a></div></div>
    <div class="list">${Array.from({ length: 12 }, (_, i) => `<div class="card"><a href="/job/1">后端开发工程师 ${i + 1} · 北京 · 应届</a><p>负责核心交易系统研发。</p></div>`).join('')}</div></body></html>`,
  // 单页应用：列表要等一个 1.5 秒的接口
  '/spa': `<html><head><title>职位</title></head><body><main id="app">加载中</main>
    <script>fetch('/api/jobs').then(r => r.json()).then(list => { document.getElementById('app').innerHTML = '<h1>全部职位（3）</h1>' + list.map(t => '<a href="/job/1">' + t + '</a>').join(' '); })</script></body></html>`,
  // 进站引导遮罩挡住整页（字节校招「AI 助手引导」实测如此）
  '/masked': `<html><head><title>职位</title></head><body><main><a id="j" href="/job/1">算法工程师</a></main>
    <div id="mask" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><button onclick="document.getElementById('mask').remove()">关闭引导</button></div></body></html>`,
  '/job/2': `<html><head><title>数据分析师</title></head><body><main><h1>数据分析师</h1><p>熟练 SQL。</p></main></body></html>`,
};
const server = createServer((req, res) => {
  if (req.url === '/api/jobs') { setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(['算法工程师', '前端开发', '产品经理'])); }, 1500); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pages[req.url] ?? '<h1>404</h1>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
let page = await context.newPage();
const deps = { isSubmitText, hasPlaceholder: t => /\{\{\s*vault:/.test(t), resolveVault: t => t.replace('{{vault:site.x.password}}', 'Secret#1'), pacingMs: [0, 0], settleMs: 300 };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  await page.goto(base + '/');
  let ob = await browse.observe(context, page, deps);
  check('观察：列出链接与搜索框，带观察编号', ob.elements.some(e => e.kind === 'link' && e.text.includes('AI 应用开发')) && ob.elements.some(e => e.kind === 'input'), ob.observation_id);

  const search = ob.elements.find(e => e.kind === 'input');
  let rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: search.ref, action: 'type', text: 'AI', submit: true }, deps);
  check('输入 + 回车：页面有变化', rc.ok && rc.observed_effect !== 'no_change', rc.observed_effect);

  const stale = await browse.act(context, page, { observation_id: ob.observation_id, ref: search.ref, action: 'click' }, deps);
  check('旧观察编号被拒（页面变过）', !stale.ok && stale.code === 'stale_observation');

  ob = await browse.observe(context, page, deps);
  const tabLink = ob.elements.find(e => e.text.includes('数据分析师'));
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: tabLink.ref, action: 'click' }, deps);
  check('点击开新标签：回执带新标签并切过去', rc.ok && rc.new_tabs.length === 1 && rc.page !== page, rc.note);
  await rc.page.close();

  ob = await browse.observe(context, page, deps);
  const jobLink = ob.elements.find(e => e.text.includes('AI 应用开发'));
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: jobLink.ref, action: 'click' }, deps);
  check('点链接跳转到详情', rc.ok && rc.observed_effect === 'navigated' && rc.url_after.endsWith('/job/1'), rc.url_after);
  page = rc.page;

  ob = await browse.observe(context, page, deps);
  const applyBtn = ob.elements.find(e => e.text.includes('立即投递'));
  check('观察：投递按钮标为提交类、提示里有 submit_page / login', applyBtn?.guarded === 'submit' && ob.hints.includes('submit_page') && ob.hints.includes('login'), ob.hints.join(','));
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: applyBtn.ref, action: 'click' }, deps);
  check('提交类按钮被拦，指向投递流程', !rc.ok && rc.code === 'submit_guarded' && rc.required_next === 'apply_flow');

  const pw = ob.elements.find(e => e.guarded === 'password');
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: pw.ref, action: 'type', text: 'plaintext' }, deps);
  check('密码框拒绝明文', !rc.ok && rc.code === 'password_needs_placeholder');
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: pw.ref, action: 'type', text: '{{vault:site.x.password}}' }, deps);
  const typed = await page.$eval('#pw', el => el.value);
  check('密码框接受占位符，在本地换成明文', rc.ok && typed === 'Secret#1');

  const r = await browse.read(page, 0, 4000);
  check('读正文：拿到岗位职责', r.text.includes('岗位职责') && r.next_offset === null);

  rc = await browse.act(context, page, { action: 'navigate', url: base + '/campus' }, deps);
  ob = await browse.observe(context, rc.page, deps);
  check('正文：头部叫 .content 时仍读到岗位列表', ob.text.includes('后端开发工程师 12'), `text_total=${ob.text_total}`);

  rc = await browse.act(context, page, { action: 'navigate', url: base + '/masked' }, deps);
  ob = await browse.observe(context, rc.page, deps);
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: ob.elements.find(e => e.text === '算法工程师').ref, action: 'click' }, deps);
  check('被引导遮罩挡住：回执说清是弹层、可以先关掉再点', !rc.ok && rc.code === 'blocked_by_overlay' && rc.retryable, rc.note.slice(0, 60));
  ob = await browse.observe(context, page, deps);
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: ob.elements.find(e => e.text === '关闭引导').ref, action: 'click' }, deps);
  ob = await browse.observe(context, page, deps);
  rc = await browse.act(context, page, { observation_id: ob.observation_id, ref: ob.elements.find(e => e.text === '算法工程师').ref, action: 'click' }, deps);
  check('关掉遮罩后再点就进了详情', rc.ok && rc.url_after.endsWith('/job/1'), rc.url_after);

  rc = await browse.act(context, page, { action: 'navigate', url: base + '/spa' }, deps);
  ob = await browse.observe(context, rc.page, deps);
  check('打开单页应用：等到接口渲染出的列表', ob.text.includes('产品经理'), ob.text.slice(0, 40));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
