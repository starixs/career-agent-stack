// 用法：node shoot-tuning.cjs <tuning.html> <输出目录>；每个变量出一张对比板
const { chromium } = require(process.env.PW);
(async () => {
  const [html, outDir] = process.argv.slice(2);
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1640, height: 200 }, deviceScaleFactor: 2 });
  for (let v = 1; v <= 7; v++) {
    await p.goto(`file://${html}?var=${v}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
    await p.screenshot({ path: `${outDir}/var-${v}.png`, fullPage: true });
  }
  await b.close();
})();
