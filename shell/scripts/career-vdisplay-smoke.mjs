// 真机冒烟：macOS 虚拟屏（browser-host/virtual-display.ts）+ 产品的启动参数 / 停靠 / 画面流。
// 运行：cd app/shell && node --import tsx/esm scripts/career-vdisplay-smoke.mjs
// 覆盖：窗口开在虚拟屏上、静止页面立刻出画面、点击生效；助手被杀时窗口停回角落（不弹到主屏正中）；正确顺序释放。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { VirtualDisplay, setVirtualParkTarget } = await import('../src/server/browser-host/virtual-display.ts');
const { embeddedWindowArgs, HUMAN_LIKE_CHROMIUM_ARGS } = await import('../src/server/browser-host/runtime-settings.ts');
const { parkWindow, PARKED_WINDOW_BOUNDS } = await import('../src/server/browser-host/page-control.ts');
const { ScreencastHub, fromPlaywrightPage } = await import('../src/server/career/screencast.ts');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const osa = s => { try { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim(); } catch (e) { return `ERR ${String(e.message).slice(0, 60)}`; } };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

let lostFired = false;
const profileDir = mkdtempSync(join(tmpdir(), 'vds-'));
const vd = new VirtualDisplay({ binDir: join(tmpdir(), 'career-vd-bin'), onLost: () => { lostFired = true; setVirtualParkTarget(null); } });
const bounds = await vd.ensure();
setVirtualParkTarget(bounds);
check('虚拟屏就绪，放在主屏左上对角', bounds.x < 0 && bounds.y < 0, JSON.stringify(bounds));

const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 }, args: [...HUMAN_LIKE_CHROMIUM_ARGS, ...embeddedWindowArgs('darwin')], ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('data:text/html,<body style="font:40px sans-serif">静止页面<button id=b onclick="this.textContent=\'ok\'">点我</button></body>');
await sleep(1200);
const pid = Number(execFileSync('pgrep', ['-f', '--', `user-data-dir=${profileDir}`], { encoding: 'utf8' }).split('\n')[0]);
const win = () => osa(`tell application "System Events" to tell (first process whose unix id is ${pid}) to get position of window 1`).split(',').map(s => Number(s.trim()));
let [wx, wy] = win();
check('窗口开在虚拟屏上（不在主屏）', wx < 0 && wy < 0, `${wx},${wy}`);

const hub = new ScreencastHub(async () => fromPlaywrightPage(page), {});
let frames = 0; const t0 = Date.now(); let first = -1;
const unsub = hub.subscribe(() => { frames++; if (first < 0) first = Date.now() - t0; });
await sleep(2500);
unsub(); await hub.stop();
check('静止页面立刻出画面', first >= 0 && first < 1000, `首帧 ${first}ms，共 ${frames} 帧`);
await page.click('#b');
check('点击生效', (await page.textContent('#b')) === 'ok');

// 模拟助手意外退出：onLost → 停回角落
execFileSync('pkill', ['-f', 'career-vdisplay-']);
await sleep(1500);
await parkWindow(ctx, page, { platform: 'darwin' });
await sleep(800);
[wx, wy] = win();
check('助手被杀：onLost 触发', lostFired);
check('窗口停回角落，没留在主屏正中', wx <= 40 && wy > 500, `${wx},${wy}（主屏中间约为 166,138）`);

await ctx.close();
vd.stop();
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`);
console.log(`（角落停靠目标 ${JSON.stringify(PARKED_WINDOW_BOUNDS)}）`);
process.exit(results.every(Boolean) ? 0 : 1);
