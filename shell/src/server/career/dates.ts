/** 招聘来信与表单里的时间规整（归档、Offer、截止事件共用）。 */

/** 没写年份的日期早于参照时间这么多天，就认为说的是下一年（十月的邮件写「1月3日」指明年一月）。 */
const YEARLESS_ROLLOVER_DAYS = 30;

/** 北京时间的 hour:minute → UTC 时刻；没给时间按当天结束前（23:59）。 */
function beijing(year: number, month: number, day: number, hour: number | null, minute: number | null): Date {
  return new Date(Date.UTC(year, month - 1, day, hour !== null ? hour - 8 : 15, minute ?? 59));
}

/** 没写年份时补参照时间的年份；早于参照时间太多就顺延到下一年。 */
function yearlessDate(refIso: string, month: number, day: number, hour: number | null, minute: number | null): string {
  const year = Number(refIso.slice(0, 4));
  const d = beijing(year, month, day, hour, minute);
  if (d.getTime() < Date.parse(refIso) - 86_400_000 * YEARLESS_ROLLOVER_DAYS) d.setUTCFullYear(year + 1);
  return d.toISOString();
}

/**
 * 把模型给的时间（ISO / "2026-10-05 14:00" / "10月5日 14:00" / "10/5"）规整成 ISO；解析不了返回 null。
 * refIso 是补年份的参照：邮件用收件时间，粘贴用当前时间。
 */
export function normalizeIso(value: string | undefined | null, refIso: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  // 只有日期（「请于 2026-11-17 前」、日期选择框）= 那天北京时间结束前，不是 UTC 零点（北京 8 点）
  const dateOnly = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return beijing(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), null, null).toISOString();
  const direct = Date.parse(v);
  if (!Number.isNaN(direct) && /\d{4}-\d{2}-\d{2}/.test(v)) return new Date(direct).toISOString();
  const cn = v.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?(?:\s*(\d{1,2})[:：点](\d{2})?)?/);
  if (cn) {
    const hour = cn[4] ? Number(cn[4]) : null;
    const minute = cn[5] ? Number(cn[5]) : null;
    if (!cn[1]) return yearlessDate(refIso, Number(cn[2]), Number(cn[3]), hour, minute);
    return beijing(Number(cn[1]), Number(cn[2]), Number(cn[3]), hour, minute).toISOString();
  }
  const dash = v.match(/(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (dash) return yearlessDate(refIso, Number(dash[1]), Number(dash[2]), dash[3] ? Number(dash[3]) : null, dash[4] ? Number(dash[4]) : null);
  return null;
}
