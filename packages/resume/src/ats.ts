/**
 * 过机筛自检：把导出的 PDF 抽出的文字与简历内容对照，回答"招聘系统能不能把这份简历读对"。
 * 文字抽取由调用方做（shell 用 pdf.js）；这里只做纯比对，便于测试。
 *
 * 检查项：文字能否读出（不是图片 / 特殊字体）、姓名与联系方式、分区标题、经历顺序（多栏会打乱）、
 * 图标字体与特殊符号、照片、页数。
 */
import { orderedSections, sectionTitle, resumeText, type Resume } from './schema.js'

export interface AtsIssue { level: 'error' | 'warn'; code: string; message: string }
export interface AtsReport { ok: boolean; score: number; issues: AtsIssue[]; extracted_chars: number; expected_chars: number; pages: number }

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')

export function atsCheck(resume: Resume, extracted: string, pages: number): AtsReport {
  const issues: AtsIssue[] = []
  const text = squash(extracted)
  const expected = squash(resumeText({ ...resume, basics: { ...resume.basics, photo_url: '' } } as Resume))
  const ratio = expected.length ? Math.min(1, text.length / expected.length) : 1
  if (text.length < 20) issues.push({ level: 'error', code: 'no_text', message: '几乎读不出文字：可能是图片或特殊字体导出的，招聘系统会当成空简历' })
  else if (ratio < 0.6) issues.push({ level: 'error', code: 'low_text', message: `只读出了约 ${Math.round(ratio * 100)}% 的内容，部分文字可能是图片或无法识别的字体` })
  const b = resume.basics
  if (b.name && !b.name.startsWith('{{') && !text.includes(squash(b.name))) issues.push({ level: 'error', code: 'name', message: '读不出姓名' })
  if (!/1[3-9]\d{9}/.test(text)) issues.push({ level: 'warn', code: 'phone', message: '读不出手机号（招聘系统靠它联系你）' })
  if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) issues.push({ level: 'warn', code: 'email', message: '读不出邮箱' })
  for (const key of orderedSections(resume)) {
    const items = (resume as unknown as Record<string, unknown[]>)[key]
    if (!Array.isArray(items) || !items.length) continue
    const title = sectionTitle(resume, key)
    if (title && !text.includes(squash(title))) issues.push({ level: 'warn', code: 'section', message: `读不出分区标题「${title}」` })
  }
  // 经历顺序：每段经历的"单位 / 项目名"应在它的第一条要点之前，各段之间也保持先后
  let cursor = -1
  for (const e of [...(resume.experience ?? []), ...(resume.projects ?? [])] as Array<{ org?: string; name?: string; title?: string; bullets?: Array<string | { text?: string }> }>) {
    const head = squash(e.org || e.name || e.title || '')
    const firstBullet = e.bullets?.[0]
    const bulletText = squash(typeof firstBullet === 'string' ? firstBullet : firstBullet?.text ?? '').slice(0, 12)
    if (!head) continue
    const hi = text.indexOf(head, Math.max(0, cursor))
    if (hi < 0) { issues.push({ level: 'warn', code: 'entry_missing', message: `读不出「${e.org || e.name || e.title}」` }); continue }
    if (bulletText) {
      const bi = text.indexOf(bulletText, hi)
      if (bi < 0) issues.push({ level: 'warn', code: 'order', message: `「${e.org || e.name || e.title}」的要点读取顺序被打乱（多栏或表格排版常见）` })
    }
    cursor = hi
  }
  if (/[-]/.test(extracted)) issues.push({ level: 'warn', code: 'icons', message: '含图标字体 / 私有区字符，招聘系统会读成乱码' })
  if (b.photo_url) issues.push({ level: 'warn', code: 'photo', message: '有照片：多数招聘系统会忽略照片，部分会把它当成无法解析的内容' })
  if (pages > 2) issues.push({ level: 'warn', code: 'pages', message: `共 ${pages} 页：校招简历建议 1 页，最多 2 页` })
  const errors = issues.filter(i => i.level === 'error').length
  const warns = issues.length - errors
  const score = Math.max(0, Math.round(100 - errors * 30 - warns * 8 - (1 - ratio) * 20))
  return { ok: errors === 0, score, issues, extracted_chars: text.length, expected_chars: expected.length, pages }
}
