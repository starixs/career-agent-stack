const { chromium } = require(process.env.PW);
(async () => {
  const [html, out, w, h] = process.argv.slice(2);
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
  await p.goto('file://' + html, { waitUntil: 'networkidle' });
  await p.screenshot({ path: out });
  await b.close();
})();
