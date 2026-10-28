// 真机冒烟：托管 Chrome 的 macOS 窗口集成——虚拟屏放置、焦点守卫、虚拟屏丢失后的隐藏兜底。
// 运行：cd app/shell && node scripts/prepare-window-helper.mjs && node --import tsx/esm scripts/career-vdisplay-smoke.mjs
// 跑的时候别打字：会触发几次托管 Chrome 抢焦点（守卫几毫秒内还回去，前台窗口的红绿灯可能闪一下灰）。
// 需要先关掉产品（会杀掉窗口助手的 display 进程来模拟虚拟屏丢失）。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { VirtualDisplay, setVirtualParkTarget, isIsolated } = await import('../src/server/browser-host/virtual-display.ts');
const { WindowGuard } = await import('../src/server/browser-host/window-guard.ts');
const { embeddedWindowArgs, HUMAN_LIKE_CHROMIUM_ARGS } = await import('../src/server/browser-host/runtime-settings.ts');
const { parkWindow, PARK_DISPLAY_SIZE, surfacelessScreenshot } = await import('../src/server/browser-host/page-control.ts');
const { ScreencastHub, fromPlaywrightPage } = await import('../src/server/career/screencast.ts');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try { execFileSync('pgrep', ['-f', 'career-window-helper']); console.error('有窗口助手在运行（产品没关？），先关掉再跑'); process.exit(2); } catch { /* 没有在跑的 */ }

const binDir = mkdtempSync(join(tmpdir(), 'cwh-bin-'));
const profileDir = mkdtempSync(join(tmpdir(), 'cwh-profile-'));
let lostFired = false;
const guard = new WindowGuard({ binDir, log: msg => console.log(`   · ${msg}`) });
const vd = new VirtualDisplay({ binDir, ...{ width: PARK_DISPLAY_SIZE.width, height: PARK_DISPLAY_SIZE.height }, log: msg => console.log(`   · ${msg}`), onLost: () => { lostFired = true; } });

// 1. 虚拟屏：和每块屏都只碰角
const bounds = await vd.ensure();
setVirtualParkTarget(bounds);
check('虚拟屏不和任何屏共用边', isIsolated({ id: bounds.displayID, ...bounds }, vd.otherDisplays()), `${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}；其余 ${JSON.stringify(vd.otherDisplays().map(d => [d.x, d.y, d.w, d.h]))}`);

// 2. 启动：守卫先认领，Chrome 开在虚拟屏上，前台不被抢
await guard.expect(profileDir);
// "没被抢"= 前台不是托管 Chrome（跑的过程中用户自己切应用不算失败）
const notStolen = probe => probe && probe.pid > 0 && probe.front !== probe.pid;
const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 }, args: [...HUMAN_LIKE_CHROMIUM_ARGS, ...embeddedWindowArgs('darwin')], ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] ?? await ctx.newPage();
// 每个文档都记下 visibilitychange 次数（隐藏兜底不能让页面察觉"切到后台"）
await ctx.addInitScript(() => { window.__visChanges = 0; document.addEventListener('visibilitychange', () => { window.__visChanges += 1; }); });
await page.goto('data:text/html,<body style="font:40px sans-serif">静止页面<button id=b onclick="this.textContent=\'ok\'">点我</button></body>');
await sleep(800);
const winBounds = async () => { const s = await ctx.newCDPSession(page); const { windowId } = await s.send('Browser.getWindowForTarget'); const { bounds: b } = await s.send('Browser.getWindowBounds', { windowId }); await s.detach(); return b; };
let wb = await winBounds();
check('窗口开在虚拟屏上', wb.left >= bounds.x && wb.top >= bounds.y && wb.left < bounds.x + bounds.w && wb.top < bounds.y + bounds.h, `${wb.left},${wb.top}`);
let probe = await guard.probe(profileDir);
check('启动后焦点没被托管 Chrome 抢走', notStolen(probe), `front=${probe.front} chrome=${probe.pid}`);

// 3. 画面与点击
const hub = new ScreencastHub(async () => fromPlaywrightPage(page), {});
let frames = 0; const t0 = Date.now(); let first = -1;
let unsub = hub.subscribe(() => { frames++; if (first < 0) first = Date.now() - t0; });
await sleep(1500); unsub(); await hub.stop();
check('静止页面立刻出画面', first >= 0 && first < 1000, `首帧 ${first}ms，共 ${frames} 帧`);
await page.click('#b');
check('点击生效', (await page.textContent('#b')) === 'ok');

// 4. 网页弹窗 / Agent 开新页：焦点还回去
await page.evaluate(() => window.open('data:text/html,popup', 'p', 'width=500,height=400'));
await sleep(600);
check('网页弹窗后焦点没被抢', notStolen(await guard.probe(profileDir)));
const p2 = await ctx.newPage(); await sleep(600);
check('Agent 开新页后焦点没被抢', notStolen(await guard.probe(profileDir)));
await p2.close(); await page.bringToFront().catch(() => {}); await sleep(300);

// 5. 虚拟屏意外消失 → 隐藏兜底（宿主的做法：藏起来 + 停回角落）
execFileSync('pkill', ['-f', 'career-window-helper.* display']);
await sleep(1200);
check('助手被杀：onLost 触发', lostFired);
setVirtualParkTarget(null);
guard.setHidden(profileDir, true);
await parkWindow(ctx, page, { platform: 'darwin' });
await sleep(800);
probe = await guard.probe(profileDir);
check('托管 Chrome 已隐藏', probe.hidden === true);
check('隐藏后焦点没被抢', notStolen(probe), `front=${probe.front}`);

// 6. 隐藏状态：页面不能察觉自己被藏起来（风控会看可见状态）
const visibility = p => p.evaluate(() => ({ state: document.visibilityState, hidden: document.hidden, changes: window.__visChanges ?? 0 }));
let vis = await visibility(page);
check('隐藏后页面仍报可见、没收到切后台事件', vis.state === 'visible' && !vis.hidden && vis.changes === 0, JSON.stringify(vis));

// 隐藏状态：截图、画面、点击、弹窗
let t1 = Date.now();
const shot = await surfacelessScreenshot(ctx, page, { type: 'jpeg', quality: 50 });
check('隐藏状态截图（fromSurface:false）', shot.length > 1000, `${shot.length}B ${Date.now() - t1}ms`);
await page.evaluate(() => { document.querySelector('#b').textContent = '点我'; });
const hiddenHub = new ScreencastHub(async () => fromPlaywrightPage(page), { surfaceless: () => true });
frames = 0;
unsub = hiddenHub.subscribe(() => { frames++; });
await sleep(1500); unsub(); await hiddenHub.stop();
check('隐藏状态现场画面在轮询出帧', frames >= 3, `1.5 秒 ${frames} 帧`);
await page.click('#b');
check('隐藏状态点击生效', (await page.textContent('#b')) === 'ok');
await page.evaluate(() => window.open('data:text/html,popup2', 'p2', 'width=500,height=400'));
await sleep(800);
probe = await guard.probe(profileDir);
check('隐藏状态网页弹窗：仍隐藏、焦点没被抢', probe.hidden === true && notStolen(probe), JSON.stringify(probe));
await page.bringToFront().catch(() => {});
await page.goto('data:text/html,<h1 style="font-size:60px">跳转后的新页面</h1>');
t1 = Date.now();
const afterNav = await surfacelessScreenshot(ctx, page, { type: 'jpeg', quality: 50 });
probe = await guard.probe(profileDir);
check('隐藏状态跳转后仍能截图、仍隐藏', afterNav.length > 1000 && probe.hidden === true && notStolen(probe), `${afterNav.length}B ${Date.now() - t1}ms`);
vis = await visibility(page);
check('隐藏期间新加载的页面也报可见', vis.state === 'visible' && !vis.hidden && vis.changes === 0, JSON.stringify(vis));
let raf = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
check('隐藏状态动画帧照常（没被当成后台节流）', raf >= 20, `1 秒 ${raf} 帧`);
const p3 = await ctx.newPage();
await p3.goto('data:text/html,<h1>隐藏期间新开的标签页</h1>');
vis = await visibility(p3);
check('隐藏期间新开的标签页也报可见', vis.state === 'visible' && !vis.hidden, JSON.stringify(vis));
await p3.close(); await page.bringToFront().catch(() => {});

// 7. 用户放出真实窗口：暂停；收回：恢复隐藏
guard.setPaused(profileDir, true); await sleep(600);
check('放出真实窗口时不再隐藏', (await guard.probe(profileDir)).hidden === false);
guard.setPaused(profileDir, false); await sleep(600);
check('收回后重新隐藏', (await guard.probe(profileDir)).hidden === true);

await ctx.close();
guard.stop();
vd.stop();
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
