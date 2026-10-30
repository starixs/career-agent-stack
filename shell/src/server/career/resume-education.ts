/**
 * 填表资料的教育经历按主简历补齐：交简历时，教育经历的起止时间只进了主简历，私密库里只有学校 / 专业 / 学历 / 毕业时间。
 *
 * 2026-10-31 实例测试：小鹏网申表教育经历的「起止时间」只能拿到毕业时间，两格都填成了 2027-06。
 * 规则：按学校对上（各只有一段时直接对上）就补缺的字段；资料里已有的值不覆盖——那可能是学生自己改过的。
 */
import type { ResumeMaster } from '@career/core';

export interface EducationRow { school: string; major?: string; degree?: string; start?: string; end?: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** 简历里写「2023.09」「2023/09」，表单引擎认「2023-09」。 */
const yearMonth = (v: unknown) => text(v).replace(/[./]/g, '-') || undefined;
const schoolKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 边界校验：填表引擎给的资料、主简历 JSON 都是 unknown，逐项确认是「有学校的一段教育经历」。 */
export function educationRows(list: unknown): EducationRow[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord)
    .map(e => ({ school: text(e.school), major: text(e.major) || undefined, degree: text(e.degree) || undefined, start: yearMonth(e.start), end: yearMonth(e.end) }))
    .filter(e => e.school);
}

/** 主简历里的教育经历；读不出来返回空（不影响填表，只是补不了）。 */
export function educationFromMaster(master: ResumeMaster | undefined): EducationRow[] {
  if (!master) return [];
  let schema: unknown;
  try { schema = JSON.parse(master.schema_json); } catch (error) {
    console.warn(`[career] resume master ${master.id} schema unreadable for education: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return isRecord(schema) ? educationRows(schema.education) : [];
}

export function withResumeEducation(current: readonly EducationRow[], fromResume: readonly EducationRow[]): EducationRow[] {
  if (!fromResume.length) return [...current];
  if (!current.length) return [...fromResume];
  const single = current.length === 1 && fromResume.length === 1;
  return current.map(row => {
    const hit = fromResume.find(r => schoolKey(r.school) === schoolKey(row.school)) ?? (single ? fromResume[0] : undefined);
    if (!hit) return row;
    return { ...row, major: row.major ?? hit.major, degree: row.degree ?? hit.degree, start: row.start ?? hit.start, end: row.end ?? hit.end };
  });
}
