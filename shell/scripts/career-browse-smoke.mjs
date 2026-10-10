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
  '/job/2': `<html><head><title>数据分析师</title></head><body><main><h1>数据分析师</h1><p>熟练 SQL。</p></main></body></html>`,
};
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pages[req.url] ?? '<h1>404</h1>'); });
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
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
