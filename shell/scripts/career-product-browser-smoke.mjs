// Real product browser + shipped extension + OTP orchestration; no account/network OTP.
// Requires the desktop's verified browser runtime. Uses an isolated temporary profile.
// node --import tsx/esm scripts/career-product-browser-smoke.mjs
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ExtensionBridge } from '../src/server/browser-host/extension-bridge/extension-bridge.ts';
import { BridgePageProxySet } from '../src/server/browser-host/extension-bridge/bridge-page-proxy.ts';
import { ProductBrowser } from '../src/server/browser-host/extension-bridge/product-browser.ts';
import { productConnectionToken } from '../src/server/browser-host/extension-bridge/connection-token.ts';
import { otpPage } from '../src/server/career/verification-page.ts';
import { runOtpFlow } from '../src/server/career/verification-flow.ts';

const root = join(homedir(), '.keystone/runtimes/browser');
const meta = z.object({ schemaVersion: z.literal(2), runtimeSet: z.string().regex(/^[a-zA-Z0-9.-]+$/), platform: z.enum(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']), executableRelativePath: z.string() }).parse(JSON.parse(await readFile(join(root, 'installed.json'), 'utf8')));
const lock = JSON.parse(await readFile(new URL('../src/shared/managed-browser-runtime.json', import.meta.url), 'utf8'));
if (meta.runtimeSet !== lock.runtimeSet || meta.executableRelativePath !== lock.officialArtifacts[meta.platform].executableRelativePath) throw new Error('Desktop runtime not current');
const executablePath = join(root, meta.runtimeSet, meta.platform, meta.executableRelativePath);
const dataDir = await mkdtemp(join(tmpdir(), 'career-product-smoke-'));
const token = productConnectionToken(dataDir);
let bridge = await ExtensionBridge.start({ port: 0, token });
let browser = new ProductBrowser(bridge, token, { dataDir, resolve: async () => ({ executablePath, revision: meta.runtimeSet }) });
let pages = new BridgePageProxySet({ bridge, tabs: bridge });
const html = `<meta charset="utf-8"><style>body{font:20px system-ui;padding:50px;background:#faf8f2}input,button{font:inherit;margin:10px;padding:8px}</style><h1>首次登录 · 本地验证小样</h1><p>只使用测试账号和测试验证码，不发送短信、邮件，不投递申请。</p><label>账号<input id="account"></label><label>验证码<input id="code"></label><button id="send" onclick="window.sent=(window.sent||0)+1">获取验证码</button><button id="login" onclick="if(window.sent===1 && document.querySelector('#code').value==='123456') document.querySelector('#ok').hidden=false">登录</button><p id="ok" hidden>已验证，继续填写网申</p>`;
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
const origin = `http://127.0.0.1:${address.port}`;
let currentPage;
try {
  await browser.start();
  const context = pages.toContext();
  for (const channel of ['sms', 'email']) {
    const page = await context.newPage(); currentPage = page;
    await page.goto(`${origin}/${channel}`);
    const deadline = Date.now() + 10_000;
    while (page.url() !== `${origin}/${channel}` && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const template = { origin, channel, recipientSelector: '#account', codeSelectors: ['#code'], sendSelector: '#send', confirmSelector: '#login', successSelector: '#ok' };
    let closed = false;
    const inner = otpPage(page, template, () => {});
    const traced = { ...inner };
    for (const method of ['visible', 'recipient', 'click', 'code']) {
      traced[method] = async (...args) => { const began = Date.now(); try { return await inner[method](...args); } finally { console.log({ step: method, ms: Date.now() - began }); } };
    }
    const status = await runOtpFlow({ page: traced, template,
      recipient: channel === 'sms' ? '13800000000' : 'fixture@example.org', signal: AbortSignal.timeout(90_000),
      prepare: async () => ({ wait: async () => '123456', close: async () => { closed = true; } }),
      solveCaptcha: async () => 'none', claimSend: () => true, assertActive: () => {}, progress: message => console.log(message) });
    const sends = await page.evaluate(() => window.sent);
    if (status !== 'changed' || !closed || sends !== 1) throw new Error(`OTP fixture failed: ${channel}`);
    console.log({ channel, status, sends, sourceClosed: closed, browserChannel: 'product-extension' });
    if (channel === 'email') {
      await writeFile('/tmp/career-product-browser-smoke.jpg', await page.screenshot());
      await page.evaluate(() => localStorage.setItem('login-fixture', 'verified'));
    }
    await page.close();
  }
  const port = bridge.port;
  await pages.releaseInput(); pages.dispose(); await browser.stop(); await bridge.stop();
  if (productConnectionToken(dataDir) !== token) throw new Error('Installation connection changed');
  bridge = await ExtensionBridge.start({ port, token });
  browser = new ProductBrowser(bridge, token, { dataDir, resolve: async () => ({ executablePath, revision: meta.runtimeSet }) });
  pages = new BridgePageProxySet({ bridge, tabs: bridge });
  await browser.start();
  currentPage = await pages.toContext().newPage();
  await currentPage.goto(`${origin}/return`);
  if (await currentPage.evaluate(() => localStorage.getItem('login-fixture')) !== 'verified') throw new Error('Login fixture state lost on restart');
  console.log({ restart: 'connected', loginState: 'preserved' });
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    console.log(await currentPage.evaluate(() => ({ url: location.pathname, sent: window.sent, successHidden: document.querySelector('#ok')?.hidden, accountLength: document.querySelector('#account')?.value.length, codeLength: document.querySelector('#code')?.value.length })));
    await writeFile('/tmp/career-product-browser-smoke.jpg', await currentPage.screenshot());
  }
  throw error;
} finally {
  await pages.releaseInput(); pages.dispose();
  await browser.stop(); await bridge.stop();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
