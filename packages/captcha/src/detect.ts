import type { CaptchaKind, CaptchaPage, CaptchaTarget, CaptchaVendor } from './types.js'

/**
 * 验证码检测：一次页内探针同时识别厂商、种类、容器矩形与题面。
 * 关键词沿用 @career/apply obstacles.ts 的思路（本包独立维护，避免包环）。
 */
export const DETECT_CAPTCHA_EXPR = `(() => {
  const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
  const all = (document.title || '') + ' ' + text;

  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const find = selector => Array.from(document.querySelectorAll(selector)).find(visible);
  const iframeBySrc = (rx) => Array.from(document.querySelectorAll('iframe'))
    .find(f => visible(f) && rx.test(f.src || ''));
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // —— 厂商识别（iframe src 优先，其次特征 class / id）——
  let vendor = 'unknown'; let anchor = null; let prompt = '';
  const hif = iframeBySrc(/hcaptcha\\.com/);
  if (hif || find('.h-captcha')) { vendor = 'hcaptcha'; anchor = hif || find('.h-captcha'); }
  const rif = iframeBySrc(/google\\.com\\/recaptcha/);
  if (vendor === 'unknown' && (rif || find('.g-recaptcha'))) { vendor = 'recaptcha'; anchor = rif || find('.g-recaptcha'); }
  const tif = iframeBySrc(/challenges\\.cloudflare\\.com/);
  if (vendor === 'unknown' && (tif || find('.cf-turnstile'))) { vendor = 'turnstile'; anchor = tif || find('.cf-turnstile'); }
  if (vendor === 'unknown' && find('.geetest_box,[class*="geetest_"],.geetest_holder')) { vendor = 'geetest'; anchor = find('.geetest_box,.geetest_popup,.geetest_holder,[class*="geetest_"]'); }
  if (vendor === 'unknown' && find('[class*="yidun"]')) { vendor = 'yidun'; anchor = find('[class*="yidun_"][class*="panel"],[class*="yidun"]'); }
  if (vendor === 'unknown' && (iframeBySrc(/captcha\\.qq\\.com|t.captcha/) || find('.tcaptcha-transform,#tcaptcha_iframe'))) {
    vendor = 'tencent';
    anchor = find('.tcaptcha-transform,#tcaptcha_iframe') || iframeBySrc(/captcha\\.qq\\.com|t\\.captcha/);
  }
  if (vendor === 'unknown' && find('#aliyunCaptcha-window,[class*="aliyunCaptcha"],#nc_1_wrapper')) {
    vendor = 'aliyun';
    anchor = find('#aliyunCaptcha-window,[class*="aliyunCaptcha"],#nc_1_wrapper');
  }

  // —— 种类识别（DOM 特征优先，文本兜底）——
  const sliderEl = find(
    '.geetest_slider_button,[class*="yidun_slider"],.nc_iconfont,.btn_slide,.slider-btn,' +
    '.slider_handler,.slider-button,[class*="slider"][class*="handler"],' +
    '#aliyunCaptcha-sliding,[class*="slide"][class*="verify"]'
  );
  const clickPromptEl = find(
    '.geetest_tip_content,.geetest_item_wrap,[class*="yidun_tips"],.tcaptcha-title,' +
    '[class*="captcha"][class*="title"]'
  );
  const imageTextInput = find(
    'input[name*="captcha" i],input[id*="captcha" i],input[placeholder*="验证码"],input[placeholder*="captcha" i]'
  );
  const captchaImg = find('img[class*="captcha" i],img[id*="captcha" i],canvas[class*="captcha" i],img[src*="captcha" i]');

  let kind = 'unknown';
  if (/checking your browser|just a moment|verify you are human|not a robot|我是人类|点击进行验证|点击上方按钮验证/.test(all)) kind = 'browser_check';
  else if (vendor === 'turnstile' || vendor === 'recaptcha' || vendor === 'hcaptcha') kind = 'browser_check';
  else if (/使图片为正|旋转|摆正|rotate/i.test(all)) kind = 'rotation';
  else if (sliderEl) kind = 'slider';
  else if (/拖动滑块|滑动验证|滑块|滑动完成拼图|向右滑动|geetest|nc_wrapper|slide to verify/i.test(all)) kind = 'slider';
  else if (clickPromptEl || /点选|按顺序点击|点击图中|依次点击|请点击.*(文字|图片)|select all images/i.test(all)) kind = 'image_click';
  else if (imageTextInput && captchaImg) kind = 'image_text';
  else if (find('input[autocomplete="one-time-code"]') || /短信验证码|手机验证码|邮箱验证码|邮件验证码|获取验证码|验证码已发送|sms code|email code|verification code sent/i.test(all)) kind = 'sms';
  else if (/图形验证码|看不清|换一张|输入图中/.test(all)) kind = 'image_text';
  if (kind === 'unknown' && vendor !== 'unknown') kind = 'browser_check';

  if (clickPromptEl) prompt = (clickPromptEl.innerText || '').trim().slice(0, 80);

  // 容器矩形：优先厂商弹层，其次滑块轨道，再次点选题面
  let rect = null;
  if (anchor) rect = rectOf(anchor);
  if (!rect && sliderEl) rect = rectOf(sliderEl.closest('[class*="slider"],[class*="captcha"],form') || sliderEl);
  if (!rect && clickPromptEl) rect = rectOf(clickPromptEl.closest('[class*="captcha"],[class*="panel"],[class*="wrap"]') || clickPromptEl);

  // 视口外 / 被遮挡的容器没有意义
  if (rect && (rect.width < 8 || rect.height < 8)) rect = null;

  const found = kind !== 'unknown' || vendor !== 'unknown';
  return found ? { kind, vendor, rect, prompt, text: text.slice(0, 200) } : null;
})()`

/** 在页面上检测验证码；返回 null 表示当前页没有可识别的验证码。 */
export async function detectCaptcha(page: CaptchaPage): Promise<CaptchaTarget | null> {
  const hit = await page.evalJson<Omit<CaptchaTarget, 'kind' | 'vendor'> & {
    kind: string; vendor: string; text?: string
  } | null>(DETECT_CAPTCHA_EXPR)
  if (!hit) return null
  const kind = normalizeKind(hit.kind)
  const vendor = normalizeVendor(hit.vendor)
  if (kind === 'unknown' && vendor === 'unknown') return null
  return { kind, vendor, rect: hit.rect ?? undefined, prompt: hit.prompt || undefined }
}

const KINDS: CaptchaKind[] = ['slider', 'rotation', 'image_click', 'image_text', 'browser_check', 'sms', 'unknown']
const VENDORS: CaptchaVendor[] = ['geetest', 'yidun', 'tencent', 'hcaptcha', 'recaptcha', 'turnstile', 'aliyun', 'unknown']
const normalizeKind = (k: string): CaptchaKind => (KINDS as string[]).includes(k) ? (k as CaptchaKind) : 'unknown'
const normalizeVendor = (v: string): CaptchaVendor => (VENDORS as string[]).includes(v) ? (v as CaptchaVendor) : 'unknown'
