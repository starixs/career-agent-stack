/**
 * DOCX 渲染：docx 库原生生成（不走 HTML 转换）。
 * 字体：中文宋体（eastAsia: SimSun）、西文 Times New Roman；Word 缺宋体时由系统做近似映射。
 * 页面 A4，边距上 9 / 下 8 / 左右 7.5 mm；正文 10pt，行距 1.42；分区标题下 1.25pt 黑线；项目符号用 Word 原生编号 + 悬挂缩进。
 */
import { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, TabStopType, LevelFormat, convertMillimetersToTwip } from 'docx'
import { existsSync, readFileSync } from 'node:fs'
import { orderedSections, sectionTitle, periodText, type Resume, type SectionKey } from '../schema.js'

const FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun', cs: 'Times New Roman' } as const
const PT = (pt: number) => Math.round(pt * 2) // docx 的字号单位是半点
const LINE_142 = 341 // 240 * 1.42
const PAGE_W = convertMillimetersToTwip(210)
const MARGIN_LR = convertMillimetersToTwip(7.5)
const TEXT_W = PAGE_W - MARGIN_LR * 2
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER } as const

function run(text: string, opts: { bold?: boolean; size?: number } = {}): TextRun {
  return new TextRun({ text, bold: opts.bold, size: PT(opts.size ?? 10), font: FONT })
}

function para(children: TextRun[], opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; before?: number; after?: number; keepNext?: boolean } = {}): Paragraph {
  return new Paragraph({ children, alignment: opts.align, keepNext: opts.keepNext, spacing: { line: LINE_142, before: opts.before ?? 0, after: opts.after ?? 0 } })
}

function heading(text: string): Paragraph {
  return new Paragraph({
    children: [run(text, { bold: true, size: 12.5 })],
    keepNext: true,
    spacing: { line: 300, before: convertMillimetersToTwip(2.6), after: convertMillimetersToTwip(1) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: '000000', space: 1 } }, // size 单位 1/8 pt → 1.25pt
  })
}

/** 条目标题行：左粗体 + 副标题，右侧日期靠右制表位（不换行）。 */
function entryRow(left: string, sub: string, right: string, first: boolean): Paragraph {
  const children = [run(left, { bold: true })]
  if (sub) children.push(run('  ' + sub))
  if (right) children.push(new TextRun({ text: '\t' + right, size: PT(10), font: FONT }))
  return new Paragraph({ children, keepNext: true, tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }], spacing: { line: LINE_142, before: first ? 0 : convertMillimetersToTwip(1.7), after: 0 } })
}

function bullets(items: string[]): Paragraph[] {
  return items.filter(Boolean).map(t => new Paragraph({ children: [run(t)], numbering: { reference: 'bullets', level: 0 }, spacing: { line: LINE_142, before: 0, after: convertMillimetersToTwip(0.45) } }))
}

function renderSection(resume: Resume, key: SectionKey): Paragraph[] {
  const title = sectionTitle(resume, key)
  const out: Paragraph[] = []
  switch (key) {
    case 'education':
      if (!resume.education.length) return []
      out.push(heading(title))
      resume.education.forEach((e, i) => {
        out.push(entryRow(e.school, [e.degree, e.major, e.gpa].filter(Boolean).join(' · '), periodText(e.start, e.end), i === 0))
        if (e.courses.length) out.push(para([run('核心课程：' + e.courses.join('、'))], { after: convertMillimetersToTwip(0.45) }))
        out.push(...bullets(e.bullets))
      })
      return out
    case 'experience':
      if (!resume.experience.length) return []
      out.push(heading(title))
      resume.experience.forEach((e, i) => {
        out.push(entryRow(e.org, [e.department, e.position, e.location].filter(Boolean).join(' · '), periodText(e.start, e.end), i === 0))
        out.push(...bullets(e.bullets))
        for (const r of e.roles) { out.push(entryRow(r.position, '', periodText(r.start, r.end), false)); out.push(...bullets(r.bullets)) }
      })
      return out
    case 'projects':
      if (!resume.projects.length) return []
      out.push(heading(title))
      resume.projects.forEach((p, i) => { out.push(entryRow(p.name, [p.role, p.org, p.link].filter(Boolean).join(' · '), periodText(p.start, p.end), i === 0)); out.push(...bullets(p.bullets)) })
      return out
    case 'skills':
      if (!resume.skills.length) return []
      out.push(heading(title))
      for (const s of resume.skills) out.push(para([run(s.name ? s.name + '：' : '', { bold: true }), run(s.keywords.join('、') + (s.level ? `（${s.level}）` : ''))], { after: convertMillimetersToTwip(0.45) }))
      return out
    case 'awards':
      if (!resume.awards.length) return []
      out.push(heading(title))
      resume.awards.forEach((a, i) => out.push(entryRow(a.title, [a.issuer, a.description].filter(Boolean).join(' · '), a.date, i === 0)))
      return out
    case 'certifications':
      if (!resume.certifications.length) return []
      out.push(heading(title))
      out.push(para([run(resume.certifications.map(c => [c.title, c.issuer, c.date].filter(Boolean).join(' ')).join('；'))]))
      return out
    case 'custom_sections':
      for (const s of resume.custom_sections) {
        if (!s.items.length) continue
        out.push(heading(s.title || title))
        s.items.forEach((it, i) => { if (it.title || it.date) out.push(entryRow(it.title, it.subtitle, it.date, i === 0)); out.push(...bullets(it.bullets)) })
      }
      return out
  }
}

function header(resume: Resume): Array<Paragraph | Table> {
  const b = resume.basics
  const contact1 = [b.phone, b.email, b.city].filter(Boolean).join('  |  ')
  const contact2 = [b.objective ? `求职意向：${b.objective}` : '', b.target_cities.length ? `期望城市：${b.target_cities.join('/')}` : '', b.expected_salary ? `期望薪资：${b.expected_salary}` : '', b.political_status ? `政治面貌：${b.political_status}` : '', b.availability ? `到岗：${b.availability}` : ''].filter(Boolean).join('  |  ')
  const links = b.links.filter(l => l.url).map(l => (l.label ? `${l.label}：${l.url}` : l.url)).join('  |  ')
  const mid: Paragraph[] = [para([run(b.name || '姓名', { bold: true, size: 18 })], { align: AlignmentType.CENTER, after: 40 })]
  for (const line of [contact1, contact2, links]) if (line) mid.push(para([run(line)], { align: AlignmentType.CENTER }))

  const photo = b.photo_url && !/^https?:/i.test(b.photo_url) && existsSync(b.photo_url) ? readFileSync(b.photo_url) : null
  if (!photo) return mid
  const type = /\.jpe?g$/i.test(b.photo_url) ? 'jpg' : 'png'
  const photoPara = new Paragraph({ alignment: AlignmentType.RIGHT, children: [new ImageRun({ type, data: photo, transformation: { width: Math.round((20 / 25.4) * 96), height: Math.round((27 / 25.4) * 96) } })] })
  const side = convertMillimetersToTwip(40)
  const cell = (children: Paragraph[], width: number) => new TableCell({ children, width: { size: width, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  return [new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [side, TEXT_W - side * 2, side], borders: NO_BORDERS, rows: [new TableRow({ children: [cell([para([])], side), cell(mid, TEXT_W - side * 2), cell([photoPara], side)] })] })]
}

/** 渲染为 DOCX Buffer（zip）。 */
export async function renderDocx(resume: Resume): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [...header(resume)]
  for (const k of orderedSections(resume)) children.push(...renderSection(resume, k))
  const doc = new Document({
    creator: resume.basics.name || 'career-agent',
    title: `${resume.basics.name} 简历`,
    styles: { default: { document: { run: { font: FONT, size: PT(10) }, paragraph: { spacing: { line: LINE_142 } } } } },
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }] }] },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: convertMillimetersToTwip(297) }, margin: { top: convertMillimetersToTwip(9), bottom: convertMillimetersToTwip(8), left: MARGIN_LR, right: MARGIN_LR } } },
      children,
    }],
  })
  return Packer.toBuffer(doc)
}
