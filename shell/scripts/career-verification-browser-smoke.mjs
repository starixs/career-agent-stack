// 本地可见浏览器小样：真实 DOM + 产品 OTP 编排，收码源为固定测试替身。
// 不连接真实邮箱/手机，不访问招聘站，不提交申请。
// node scripts/career-verification-browser-smoke.mjs（需要已安装的 ego-browser）
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'career-otp-smoke-'));
const bundle = join(dir, 'otp.mjs');
try {
  await build({ stdin: { contents: "export { otpPage } from './src/server/career/verification-page'; export { runOtpFlow } from './src/server/career/verification-flow';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const html = `<meta charset="utf-8"><h1>本地网申验证测试</h1><label>账号<input id="account"></label><label>验证码<input id="code"></label><button id="send" onclick="window.sent=(window.sent||0)+1">获取验证码</button><button id="login" onclick="if(window.sent===1 && document.querySelector('#code').value==='123456') document.querySelector('#ok').hidden=false">登录</button><p id="ok" hidden>验证成功，可继续填写</p>`;
  const script = `
    const { otpPage, runOtpFlow } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    const task = await taskSpace('career-otp-fixture-check');
    const page = task.page('p1');
    for (const channel of ['sms', 'email']) {
      const html = ${JSON.stringify(html)};
      await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      let currentUrl = await page.url();
      const adapter = {
        url: () => currentUrl,
        evaluate: async (fn, arg) => { const result = await page.evaluate(fn, arg); currentUrl = await page.url(); return result; },
        fill: (s, v) => page.fill(s, v), click: s => page.click(s),
      };
      // data: 测试页的 origin 为 null；不经真实配置加载器，也不授予任何站点权限。
      const template = { origin: new URL(currentUrl).origin, channel, recipientSelector: '#account', codeSelectors: ['#code'], sendSelector: '#send', confirmSelector: '#login', successSelector: '#ok' };
      let closed = false;
      const status = await runOtpFlow({ page: otpPage(adapter, template, () => {}), template, recipient: channel === 'sms' ? '13800000000' : 'fixture@example.org', signal: new AbortController().signal, prepare: async () => ({ wait: async () => '123456', close: async () => { closed = true; } }), solveCaptcha: async () => 'none', claimSend: () => true, assertActive: () => {}, progress: () => {} });
      const sent = await page.evaluate(() => window.sent);
      if (status !== 'changed' || !closed || sent !== 1) throw new Error('OTP fixture failed: ' + channel);
      console.log({ channel, status, sourceClosed: closed, sends: sent });
    }
    await task.finish({ keep: [] });
  `;
  process.stdout.write(execFileSync('ego-browser', ['nodejs', '-e', script], { encoding: 'utf8', timeout: 120_000 }));
} finally { await rm(dir, { recursive: true, force: true }); }
