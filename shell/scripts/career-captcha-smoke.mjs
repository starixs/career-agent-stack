// 真实 Chrome 冒烟：验证码自己过（career/captcha-solver.ts）+ 请用户帮一下再接着办（career/browse-handoff.ts）+ 坐标操作的闸。
// 运行：cd app/shell && node --import tsx/esm scripts/career-captcha-smoke.mjs [--headed]
// 模型用「知道答案的假模型」：测的是机制（编号 → 坐标、拖动、验收、交接），不是视觉模型认得准不准（那个看 career-browse-agent-smoke.mjs）。
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browse = await import('../src/server/career/browse.ts');
const { waitForUser, hintSampleInPage } = await import('../src/server/career/browse-handoff.ts');
const solver = await import('../src/server/career/captcha-solver.ts');
const { overlayMarks } = await import('../src/server/career/captcha-overlay.ts');
const { isSubmitText, classifyCaptcha } = await import('@career/apply');

const PASS = `document.body.innerHTML = '<main><h1>验证通过</h1><p>欢迎回来</p></main>'`;
/** 点选题：三个字在验证码图里的位置（CSS 像素，相对图的左上角） */
const CLICK_TARGETS = [['甲', 40, 40], ['乙', 200, 95], ['丙', 135, 28]];
const SLIDER_GAP = 180;
const pages = {
  '/cap/text': `<html><body><form class="verify-form"><p>请完成验证：请输入图中验证码</p>
    <img class="captcha-img" width="120" height="40" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#eee"/><text x="12" y="29" font-size="24" font-family="Arial">K7P2</text></svg>')}">
    <input type="text" id="v"><button type="button">确定</button></form>
    <script>document.getElementById('v').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value === 'K7P2') { e.preventDefault(); ${PASS} } })</script></body></html>`,
  '/cap/click': `<html><body><div><p>请完成验证：请依次点击【甲,乙,丙】</p>
    <div class="captcha-img" style="position:relative;width:300px;height:150px;background:#f3f3f3">${CLICK_TARGETS.map(([c, x, y]) => `<span style="position:absolute;left:${x - 10}px;top:${y - 10}px;font-size:20px;line-height:20px">${c}</span>`).join('')}</div></div>
    <script>const want = ${JSON.stringify(CLICK_TARGETS)}; const got = [];
      document.querySelector('.captcha-img').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); got.push([e.clientX - r.left, e.clientY - r.top]);
        if (got.length === want.length) { if (want.every(([, x, y], i) => Math.hypot(got[i][0] - x, got[i][1] - y) <= 18)) { ${PASS} } else got.length = 0; } });</script></body></html>`,
  '/cap/slider': `<html><body><p>请完成验证：拖动滑块完成拼图</p>
    <div class="slider-captcha" style="width:300px;height:150px;background:linear-gradient(90deg,#ddd ${SLIDER_GAP}px,#555 ${SLIDER_GAP}px,#555 ${SLIDER_GAP + 40}px,#ddd ${SLIDER_GAP + 40}px)"></div>
    <div class="slider-track" style="position:relative;width:300px;height:40px;background:#eee"><div class="slider_btn" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#39f"></div></div>
    <script>const h = document.querySelector('.slider_btn'); let sx = null;
      h.addEventListener('mousedown', e => { sx = e.clientX; });
      document.addEventListener('mousemove', e => { if (sx !== null) h.style.left = (e.clientX - sx) + 'px'; });
      document.addEventListener('mouseup', e => { if (sx === null) return; const off = e.clientX - sx; sx = null; if (Math.abs(off - ${SLIDER_GAP}) <= 6) { ${PASS} } else h.style.left = '0px'; });</script></body></html>`,
  '/login': `<html><body><main id="m">请使用微信扫码登录 <input type="password"></main>
    <script>setTimeout(() => { document.getElementById('m').innerHTML = '欢迎回来，同学'; }, 1200)</script></body></html>`,
  '/job': `<html><body><main><h1>算法工程师</h1><button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px">立即投递</button></main></body></html>`,
  '/antispider/': `<html><body><p>需要您协助验证</p><button id="s" style="position:absolute;left:100px;top:100px;width:120px;height:40px" onclick="document.title='passed'">提交</button></body></html>`,
};
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pages[req.url] ?? '<h1>404</h1>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 假视觉模型：按题型回答已知答案；点选题按提示里的行列数把已知位置换成格子号（验证编号来回换算一致）。 */
const fakeLlm = { calls: 0, async complete({ messages }) {
  this.calls += 1;
  const p = messages[0].content;
  if (!messages[0].images?.[0]?.data) throw new Error('没有带图');
  if (p.includes('图形验证码')) return { text: '{"text":"K7P2"}' };
  if (p.includes('点选')) {
    const [, cols, rows] = /（(\d+) 列 × (\d+) 行/.exec(p).map(Number);
    const cells = CLICK_TARGETS.map(([, x, y]) => Math.floor(y / (150 / rows)) * cols + Math.floor(x / (300 / cols)) + 1);
    return { text: JSON.stringify({ cells }) };
  }
  return { text: JSON.stringify({ piece: 0, gap: SLIDER_GAP / solver.TICK_PX }) };
} };

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const deps = { isSubmitText, pacingMs: [0, 0], settleMs: 100 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const blocked = async () => { const h = browse.detectHints(await browse.inPage(page, hintSampleInPage, null), []); return h.includes('captcha') || h.includes('risk'); };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  for (const [path, kind] of [['/cap/text', 'image_text'], ['/cap/click', 'image_click'], ['/cap/slider', 'slider']]) {
    await page.goto(base + path);
    const sample = await browse.inPage(page, hintSampleInPage, null);
    const classified = classifyCaptcha({ title: '', text: sample.bodySample });
    check(`${path}：认出题型 ${kind}，提示里有 captcha`, classified === kind && (await blocked()), classified);
    const r = await solver.solveCaptcha(page, kind, { llm: fakeLlm, overlay: overlayMarks, sleep: ms => sleep(Math.min(ms, 400)) }, blocked);
    check(`${path}：自己过了`, r.status === 'solved' && (await page.textContent('body')).includes('验证通过'), r.steps.join('；'));
  }

  await page.goto(base + '/login');
  const w = await waitForUser(page, { blocking: ['login'], timeoutMs: 8000, pollMs: 200 });
  check('请用户扫码：登录框消失后自己接着办', w.status === 'done' && !w.hints.includes('login'), `${w.status} ${w.waited_ms}ms`);
  await page.goto(base + '/login');
  const t = await waitForUser(page, { blocking: ['login'], timeoutMs: 500, pollMs: 200 });
  check('用户还没扫：到时返回 timeout，不是报错', t.status === 'timeout' && t.hints.includes('login'), t.status);
  let handed = false; setTimeout(() => { handed = true; }, 300);
  await page.goto(base + '/job');
  const hb = await waitForUser(page, { blocking: [], timeoutMs: 5000, pollMs: 100, handedBack: () => handed });
  check('用户点了交还：立即接着办', hb.status === 'handed_back', `${hb.waited_ms}ms`);

  let rc = await browse.act(context, page, { action: 'click_at', x: 160, y: 120 }, deps);
  check('坐标点到「立即投递」：被拦', !rc.ok && rc.code === 'submit_guarded', rc.note);
  await page.goto(base + '/antispider/');
  rc = await browse.act(context, page, { action: 'click_at', x: 160, y: 120 }, deps);
  check('专门的验证页上的「提交」可以点（只是过验证）', rc.ok && (await page.title()) === 'passed');
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过（假模型被调用 ${fakeLlm.calls} 次）`);
process.exit(failed ? 1 : 0);
