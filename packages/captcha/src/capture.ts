import type { CaptchaPage, CaptchaRect } from './types.js'

/**
 * 取图通道（TMWebDriver SOP 的结论）：
 *  - CDP `Page.captureScreenshot`（format:png，可带 clip）：后台 / 不可见页也能截，全页高清，首选。
 *  - 无 CDP 时退回 page.screenshot()。
 *  - canvas 验证码直接 `canvas.toDataURL()` 最干净。
 */

/** 截全页或容器区域，返回 base64（不带 data: 前缀）。 */
export async function capturePngBase64(page: CaptchaPage, clip?: CaptchaRect): Promise<string> {
  const cdp = page.cdp()
  if (cdp) {
    const params: Record<string, unknown> = { format: 'png' }
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    const res = await cdp.send('Page.captureScreenshot', params) as { data: string }
    return res.data
  }
  const bytes = await page.screenshot()
  return Buffer.from(bytes).toString('base64')
}

/** 取 canvas / img 验证码图（canvas 用 toDataURL；img 用 src 直接读）。 */
export async function captchaImageDataUrl(page: CaptchaPage, selector: string): Promise<string | null> {
  return page.evalJson<string | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    if (el.tagName === 'CANVAS') { try { return el.toDataURL('image/png'); } catch (e) { return null; } }
    const src = el.src || '';
    return src.startsWith('data:image') ? src : (src || null);
  })()`)
}

/** data URL / base64 → { data, mediaType }（喂 LlmImage）。 */
export function toLlmImage(dataUrlOrBase64: string): { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } {
  const m = dataUrlOrBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s)
  if (m) return { mediaType: m[1] as 'image/png', data: m[2] }
  return { mediaType: 'image/png', data: dataUrlOrBase64 }
}
