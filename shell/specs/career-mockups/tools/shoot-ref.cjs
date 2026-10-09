const { chromium } = require(process.env.PW);
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  await p.goto('file://' + process.argv[2], { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await p.screenshot({ path: process.argv[3], fullPage: true });
  await b.close();
})();
