/**
 * 验证码短信的纯解析：取码、取【签名】、解析蓝牙短信（MAP）里的时间。
 * 原生助手只负责把「像验证码的短信」原文交出来；判断哪一串是码、属于哪个站点都在这里，便于测试。
 */

const KEYWORD = '(?:验证码|校验码|动态码|确认码|驗證碼|激活码|动态密码|verification code|code|OTP)';
/** 码本身：4–8 位数字，或 4–8 位含数字的字母数字串（少数站点用）。 */
const CODE = '([0-9]{4,8}|(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{4,8})';
/** 关键词与码之间允许的连接字（「验证码：」「验证码为」「code is」等），最长这么多个字符。 */
const MAX_GAP = 12;

const AFTER_KEYWORD = new RegExp(`${KEYWORD}[^0-9A-Za-z]{0,${MAX_GAP}}?(?:为|是|is|:|：)?\\s*${CODE}(?![0-9A-Za-z])`, 'i');
const BEFORE_KEYWORD = new RegExp(`(?<![0-9A-Za-z])${CODE}[^0-9A-Za-z]{0,${MAX_GAP}}(?:是|为|is)?[^0-9A-Za-z]{0,4}(?:您的|你的|your)?\\s*${KEYWORD}`, 'i');
const LONE_DIGITS = /(?<![0-9])[0-9]{4,8}(?![0-9])/g;

/** 从正文取验证码；取不到返回 null。宁可取不到，不取错。 */
export function extractCode(body: string): string | null {
  const text = body.replace(/\s+/g, ' ');
  const after = AFTER_KEYWORD.exec(text);
  if (after?.[1] && !/^[A-Za-z]+$/.test(after[1])) return after[1];
  const before = BEFORE_KEYWORD.exec(text);
  if (before?.[1]) return before[1];
  // 关键词在、但码的位置不规整：全文只有一串 4–8 位数字时才认
  if (!new RegExp(KEYWORD, 'i').test(text)) return null;
  const lone = text.match(LONE_DIGITS) ?? [];
  return lone.length === 1 ? lone[0]! : null;
}

/** 【签名】：国内短信放在开头或结尾。没有返回 null。 */
export function smsSignature(body: string): string | null {
  const m = /^\s*【([^】]{1,30})】/.exec(body) ?? /【([^】]{1,30})】\s*$/.exec(body);
  return m?.[1] ?? null;
}

/** MAP 时间（手机本地时间，形如 20261103T122707）→ ISO 字符串；解析不了返回 null。 */
export function parseMapTime(raw: string, tzOffsetMinutes = -new Date().getTimezoneOffset()): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const utc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) - tzOffsetMinutes * 60_000;
  return Number.isNaN(utc) ? null : new Date(utc).toISOString();
}
