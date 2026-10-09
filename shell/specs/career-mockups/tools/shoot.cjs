// 用法：node shoot.cjs <html> <out.png> <query>；等字体加载完再截图
const { chromium } = require(process.env.PW);
(async () => {
  const [html, out, q] = process.argv.slice(2);
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('file://' + html + (q ? '?' + q : ''), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(800);
  const ok = await p.evaluate(() => document.fonts.check('600 22px "LXGW WenKai Screen"', '投递线'));
  console.log(out, 'wenkai:', ok);
  await p.screenshot({ path: out });
  await b.close();
})();
