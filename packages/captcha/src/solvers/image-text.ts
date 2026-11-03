import { extractJson } from '@career/core'
import { capturePngBase64, captchaImageDataUrl, toLlmImage } from '../capture.js'
import { humanClick, humanType } from '../human-input.js'
import type { SolveResult, SolverDeps } from '../types.js'

/**
 * 图形字符码求解：取验证码图（canvas 直读 toDataURL 最干净，否则截容器）→
 * 视觉模型 OCR → 可信键入到输入框 → blur 触发校验。
 */

interface GraphicalProbe {
  imageSelector: string | null
  imageRect: { x: number; y: number; width: number; height: number } | null
  inputSelector: string | null
}

const PROBE_EXPR = `(() => {
  const img = document.querySelector('canvas[class*="captcha" i],img[class*="captcha" i],img[id*="captcha" i],img[src*="captcha" i],canvas[id*="captcha" i]');
  const input = document.querySelector('input[name*="captcha" i],input[id*="captcha" i],input[placeholder*="验证码"],input[placeholder*="captcha" i]');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return {
    imageSelector: img ? (img.tagName === 'CANVAS' ? 'canvas' : 'img') + (img.className && typeof img.className === 'string' ? '.' + img.className.trim().split(/\\s+/)[0] : '') : null,
    imageRect: img ? rect(img) : null,
    inputSelector: input ? (input.name ? 'input[name="' + input.name + '"]' : 'input[id="' + input.id + '"]') : null,
  };
})()`

export async function solveImageText(deps: SolverDeps): Promise<SolveResult> {
  const cdp = deps.page.cdp()
  if (!cdp) return { outcome: 'needs_cdp', detail: '没有 CDP 会话，键入需要可信键盘事件', attempts: 0 }
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const rand = deps.rand ?? Math.random
  const maxAttempts = deps.maxAttempts ?? 2

  const probe = await deps.page.evalJson<GraphicalProbe | null>(PROBE_EXPR)
  if (!probe?.inputSelector) return { outcome: 'failed', detail: '找不到验证码输入框', attempts: 0 }

  let lastErr = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 图：canvas 优先 toDataURL；否则 CDP 截容器
    let imageData: string | null = null
    if (probe.imageSelector) {
      try { imageData = await captchaImageDataUrl(deps.page, probe.imageSelector) } catch { imageData = null }
      if (!imageData && probe.imageRect) {
        // img src 不是 data URL（跨域地址）：改截图
        imageData = await capturePngBase64(deps.page, probe.imageRect)
      } else if (imageData && !imageData.startsWith('data:')) {
        imageData = probe.imageRect ? await capturePngBase64(deps.page, probe.imageRect) : null
      }
    } else if (probe.imageRect) {
      imageData = await capturePngBase64(deps.page, probe.imageRect)
    }
    if (!imageData) return { outcome: 'failed', detail: '拿不到验证码图片', attempts: attempt - 1 }

    let text: string
    try {
      const res = await deps.llm.complete({
        json: true,
        maxTokens: 100,
        messages: [{
          role: 'user',
          content: '识别这张图形验证码里的字符（区分大小写，忽略干扰线）。只回 JSON：{"text": "<字符>"}',
          images: [toLlmImage(imageData)],
        }],
      })
      text = extractJson<{ text: string }>(res.text).text?.trim() ?? ''
    } catch (e) {
      return { outcome: 'failed', detail: `视觉识别失败: ${String(e)}`, attempts: attempt - 1 }
    }
    if (!text || text.length > 8) { lastErr = '识别结果格式异常'; continue }

    // 先可信点击输入框中心（聚焦），再键入
    const center = await inputCenter(deps, probe.inputSelector)
    if (center) await humanClick({ cdp, rand, sleep }, center.x, center.y)
    await sleep(150 + rand() * 150)
    await humanType({ cdp, rand, sleep }, text, {
      focusFirst: () => deps.page.evalJson(`(() => { const i = document.querySelector(${JSON.stringify(probe.inputSelector)}); if (i) { i.focus(); i.value = ''; } return !!i; })()`).then(() => undefined),
    })
    await sleep(600 + rand() * 400)
    // 清空 value 后由 keyDown/text 逐字键入；部分站点 blur 才校验
    await deps.page.evalJson(`(() => { const i = document.querySelector(${JSON.stringify(probe.inputSelector)}); if (i) i.blur(); return true; })()`).catch(() => null)
    await sleep(500)

    const passed = await deps.page.evalJson<boolean>(`(() => {
      const t = (document.body.innerText || '').slice(0, 2000);
      if (/验证码错误|验证码不正确|incorrect captcha/i.test(t)) return false;
      return !/图形验证码|请输入验证码/.test(t);
    })()`)
    if (passed) return { outcome: 'passed', detail: '图形字符码已通过', attempts: attempt }
    lastErr = '图形字符码未通过校验'
  }
  return { outcome: 'failed', detail: lastErr, attempts: maxAttempts }
}

async function inputCenter(_deps: SolverDeps, selector: string): Promise<{ x: number; y: number }> {
  return _deps.page.evalJson<{ x: number; y: number }>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`).then(r => r ?? { x: 0, y: 0 })
}
