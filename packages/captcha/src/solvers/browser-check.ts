import { humanClick } from '../human-input.js'
import { waitForVerification } from '../verification.js'
import type { SolveResult, SolverDeps } from '../types.js'

/**
 * 浏览器环境检查求解（Cloudflare Turnstile / reCAPTCHA 复选框 / 极验圆形按钮）：
 * 这类的"验证"本质是一次 isTrusted 的真实点击——找复选框 / 按钮的可视矩形，
 * 可信点击其中心，等待判定完成。查不出矩形的（隐形 reCAPTCHA v3）不需要点击，
 * 行为分由人类化操作历史决定，直接判 unsupported 留给核验结果。
 */

const PROBE_EXPR = `(() => {
  // 复选框通常在跨域 iframe 里拿不到内部 DOM，但 iframe 自身矩形可得；点击 iframe 内复选框的典型位置（居中）
  const candidates = [
    { sel: 'iframe[src*="challenges.cloudflare.com"]', where: 'center', kind: 'turnstile' },
    { sel: 'iframe[title*="reCAPTCHA"]', where: 'center', kind: 'recaptcha' },
    { sel: 'iframe[src*="recaptcha/api2/anchor"]', where: 'center', kind: 'recaptcha' },
    { sel: '.geetest_radar_tip', where: 'center', kind: 'geetest' },
    { sel: '[class*="yidun"][class*="tips"]', where: 'center', kind: 'yidun' },
    { sel: '[class*="verify"][class*="bar"],[class*="captcha"][class*="btn"]', where: 'center', kind: 'unknown' },
  ];
  for (const c of candidates) {
    const el = document.querySelector(c.sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) continue;
    // 可见性粗查：完全滚出视口的不点
    if (r.bottom < 0 || r.top > innerHeight) continue;
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, kind: c.kind };
  }
  return null;
})()`

async function verifyPassed(deps: SolverDeps): Promise<boolean> {
  return deps.page.evalJson<boolean>(`(() => {
    // Turnstile 通过后隐藏的 textarea 会带上 token
    const cf = document.querySelector('textarea[name="cf-turnstile-response"],[name="cf-turnstile-response"]');
    if (cf && (cf.value || '').length > 10) return true;
    if (document.querySelector('.geetest_success,[class*="yidun"][class*="success"]')) return true;
    const t = (document.body.innerText || '').slice(0, 2000);
    return !/checking your browser|just a moment|verify you are human|点击进行验证|请完成验证/.test(t);
  })()`)
}

export async function solveBrowserCheck(deps: SolverDeps): Promise<SolveResult> {
  const cdp = deps.page.cdp()
  if (!cdp) return { outcome: 'needs_cdp', detail: '没有 CDP 会话，复选框需要可信点击', attempts: 0 }
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const maxAttempts = deps.maxAttempts ?? 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await deps.page.evalJson<{ rect: { x: number; y: number; width: number; height: number }; kind: string } | null>(PROBE_EXPR)
    if (!probe) {
      // 隐形检查（无框可点）：多半在跑行为分，等一拍再核验
      if (await waitForVerification(() => verifyPassed(deps), sleep, 4000, 250)) return { outcome: 'passed', detail: '隐形检查等待后通过', attempts: attempt - 1 }
      return { outcome: 'unsupported', detail: '没有可点击的验证框（隐形检查未放行），留给人工', attempts: attempt - 1 }
    }
    // 先点击页面任意无害处再点框（人类常见节奏，也顺便给 hover 依赖组件预热）
    await humanClick({ cdp, sleep }, probe.rect.x + probe.rect.width / 2, probe.rect.y + probe.rect.height / 2)
    if (await waitForVerification(() => verifyPassed(deps), sleep, 4200, 200)) return { outcome: 'passed', detail: `点击验证框（${probe.kind}）后通过`, attempts: attempt }
  }
  return { outcome: 'failed', detail: '点击验证框后仍未放行', attempts: maxAttempts }
}
