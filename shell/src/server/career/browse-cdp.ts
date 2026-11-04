/**
 * 模型直发 CDP 的纯逻辑（思路来自 GenericAgent tmwd_cdp_bridge / tmwebdriver_sop，MIT）：
 * 浏览器桥的 `chrome.debugger` 本身什么域都能发，这里在产品侧收窄白名单——
 * 跨域 iframe（Page.getFrameTree → Page.createIsolatedWorld → Runtime.evaluate）、
 * 量坐标、可信输入、截图够用；Target / Network / Storage / Browser 这类能改身份、
 * 改 Cookie、开新目标的不开放给模型。
 */

/** 允许的 CDP 域；方法名一段（Runtime.evaluate），不带点号嵌套。 */
const ALLOWED_CDP_RX = /^(Page|Input|DOM|Runtime|Emulation)\.[A-Za-z][A-Za-z0-9]*$/;

export function cdpMethodAllowed(method: string): boolean {
  return ALLOWED_CDP_RX.test(method);
}

/** 超过这个长度的字符串按「已省略」处理：Page.captureScreenshot 的 base64 会有几 MB。 */
const LONG_STRING_LIMIT = 256;

function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > LONG_STRING_LIMIT ? `[${value.length} chars omitted]` : value;
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 8) return '[deep object omitted]';
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = sanitize(item, depth + 1);
  return out;
}

/** 递归截掉超长字符串（截图、整页 HTML），小结构和短值原样返回给模型。 */
export function sanitizeCdpResult(data: unknown): unknown {
  return sanitize(data, 0);
}
