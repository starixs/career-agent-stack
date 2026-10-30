/** 招聘来信与表单里的时间规整（归档、Offer、截止事件共用）。 */

/** 把模型给的时间（ISO / "2026-10-05 14:00" / "10月5日 14:00"）规整成 ISO；解析不了返回 null。 */
export function normalizeIso(value: string | undefined | null, nowIso: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  // 只有日期（「请于 2026-11-17 前」、日期选择框）= 那天北京时间结束前，不是 UTC 零点（北京 8 点）
  const dateOnly = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 15, 59)).toISOString();
  const direct = Date.parse(v);
  if (!Number.isNaN(direct) && /\d{4}-\d{2}-\d{2}/.test(v)) return new Date(direct).toISOString();
  const cn = v.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?(?:\s*(\d{1,2})[:：点](\d{2})?)?/);
  if (cn) {
    const year = cn[1] ? Number(cn[1]) : Number(nowIso.slice(0, 4));
    const d = new Date(Date.UTC(year, Number(cn[2]) - 1, Number(cn[3]), cn[4] ? Number(cn[4]) - 8 : 15, cn[5] ? Number(cn[5]) : 59));
    if (!cn[1] && d.getTime() < Date.parse(nowIso) - 86_400_000 * 30) d.setUTCFullYear(year + 1);
    return d.toISOString();
  }
  const dash = v.match(/(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (dash) {
    const year = Number(nowIso.slice(0, 4));
    const d = new Date(Date.UTC(year, Number(dash[1]) - 1, Number(dash[2]), dash[3] ? Number(dash[3]) - 8 : 15, dash[4] ? Number(dash[4]) : 59));
    return d.toISOString();
  }
  return null;
}
