const { chromium } = require(process.env.PW);
(async () => {
  const [html, out, w] = process.argv.slice(2);
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: +w, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('file://' + html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(800);
  console.log(await p.evaluate(() => ['Inter','Source Sans 3','Nunito','LXGW WenKai Screen'].map(f => f + ':' + document.fonts.check(`16px "${f}"`, 'Ab')).join(' ')));
  await p.screenshot({ path: out, fullPage: true });
  await b.close();
})();
