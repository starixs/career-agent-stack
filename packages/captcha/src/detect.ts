import type { CaptchaKind, CaptchaPage, CaptchaTarget, CaptchaVendor } from './types.js'

/**
 * 验证码检测：一次页内探针同时识别厂商、种类、容器矩形与题面。
 * 关键词沿用 @career/apply obstacles.ts 的思路（本包独立维护，避免包环）。
 */
export const DETECT_CAPTCHA_EXPR = `(() => {
  const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
  const all = (document.title || '') + ' ' + text;

  const iframeBySrc = (rx) => Array.from(document.querySelectorAll('iframe'))
    .find(f => rx.test(f.src || ''));
  const cls = (rx) => document.querySelector('[class*="' + rx + '"], .' + rx);
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // —— 厂商识别（iframe src 优先，其次特征 class / id）——
  let vendor = 'unknown'; let anchor = null; let prompt = '';
  const hif = iframeBySrc(/hcaptcha\\.com/);
  if (hif || document.querySelector('.h-captcha,[data-sitekey]')) { vendor = 'hcaptcha'; anchor = hif || document.querySelector('.h-captcha'); }
  const rif = iframeBySrc(/google\\.com\\/recaptcha/);
  if (vendor === 'unknown' && (rif || document.querySelector('.g-recaptcha'))) { vendor = 'recaptcha'; anchor = rif || document.querySelector('.g-recaptcha'); }
  const tif = iframeBySrc(/challenges\\.cloudflare\\.com/);
  if (vendor === 'unknown' && (tif || document.querySelector('.cf-turnstile'))) { vendor = 'turnstile'; anchor = tif || document.querySelector('.cf-turnstile'); }
  if (vendor === 'unknown' && document.querySelector('.geetest_box,[class*="geetest_"],.geetest_holder')) { vendor = 'geetest'; anchor = document.querySelector('.geetest_box,.geetest_popup,.geetest_holder,[class*="geetest_"]'); }
  if (vendor === 'unknown' && document.querySelector('[class*="yidun"]')) { vendor = 'yidun'; anchor = document.querySelector('[class*="yidun_"][class*="panel"],[class*="yidun"]'); }
  if (vendor === 'unknown' && (iframeBySrc(/captcha\\.qq\\.com|t.captcha/) || document.querySelector('.tcaptcha-transform,#tcaptcha_iframe'))) {
    vendor = 'tencent';
    anchor = document.querySelector('.tcaptcha-transform,#tcaptcha_iframe') || iframeBySrc(/captcha\\.qq\\.com|t\\.captcha/);
  }
  if (vendor === 'unknown' && document.querySelector('#aliyunCaptcha-window,[class*="aliyunCaptcha"],#nc_1_wrapper')) {
    vendor = 'aliyun';
    anchor = document.querySelector('#aliyunCaptcha-window,[class*="aliyunCaptcha"],#nc_1_wrapper');
  }

  // —— 种类识别（DOM 特征优先，文本兜底）——
  const sliderEl = document.querySelector(
    '.geetest_slider_button,[class*="yidun_slider"],.nc_iconfont,.btn_slide,.slider-btn,' +
    '.slider_handler,.slider-button,[class*="slider"][class*="handler"],' +
    '#aliyunCaptcha-sliding,[class*="slide"][class*="verify"]'
  );
  const clickPromptEl = document.querySelector(
    '.geetest_tip_content,.geetest_item_wrap,[class*="yidun_tips"],.tcaptcha-title,' +
    '[class*="captcha"][class*="title"],[class*="prompt"]'
  );
  const imageTextInput = document.querySelector(
    'input[name*="captcha" i],input[id*="captcha" i],input[placeholder*="验证码"],input[placeholder*="captcha" i]'
  );
  const captchaImg = document.querySelector('img[class*="captcha" i],img[id*="captcha" i],canvas[class*="captcha" i],img[src*="captcha" i]');

  let kind = 'unknown';
  if (/checking your browser|just a moment|verify you are human|not a robot|我是人类|点击进行验证|点击上方按钮验证/.test(all)) kind = 'browser_check';
  else if (vendor === 'turnstile' || vendor === 'recaptcha' || vendor === 'hcaptcha') kind = 'browser_check';
  else if (sliderEl) kind = 'slider';
  else if (/拖动滑块|滑动验证|滑块|滑动完成拼图|向右滑动|geetest|nc_wrapper|slide to verify/i.test(all)) kind = 'slider';
  else if (clickPromptEl || /点选|按顺序点击|点击图中|依次点击|请点击.*(文字|图片)|select all images/i.test(all)) kind = 'image_click';
  else if ((imageTextInput && captchaImg) || /图形验证码|看不清|换一张|输入图中|请输入验证码/.test(all)) kind = 'image_text';
  else if (/短信验证码|手机验证码|获取验证码|验证码已发送|sms code|verification code sent/i.test(all)) kind = 'sms';
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

const KINDS: CaptchaKind[] = ['slider', 'image_click', 'image_text', 'browser_check', 'sms', 'unknown']
const VENDORS: CaptchaVendor[] = ['geetest', 'yidun', 'tencent', 'hcaptcha', 'recaptcha', 'turnstile', 'aliyun', 'unknown']
const normalizeKind = (k: string): CaptchaKind => (KINDS as string[]).includes(k) ? (k as CaptchaKind) : 'unknown'
const normalizeVendor = (v: string): CaptchaVendor => (VENDORS as string[]).includes(v) ? (v as CaptchaVendor) : 'unknown'
