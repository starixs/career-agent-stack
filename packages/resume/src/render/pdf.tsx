/**
 * PDF 渲染：@react-pdf/renderer，A4 单栏中文模板 ClassicCN。
 * 版式按《默认简历版式规范》：上 9 / 下 8 / 左右 7.5 mm；姓名 18pt、分区标题 12.5pt、正文 10pt；分区标题下 1.4px 黑线；行高 1.42。
 */
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { ReactElement } from 'react'
import { orderedSections, sectionTitle, periodText, resumeText, type Resume, type SectionKey } from '../schema.js'
import { fontStackFor, cjkHyphenation, type FontStack } from './fonts.js'
import { wrapText, packSegments, measureText, CLASSIC_CN } from './measure.js'

export type PdfTemplate = 'ClassicCN'
export interface RenderPdfOptions { template?: PdfTemplate }

const mm = (v: number) => (v * 72) / 25.4
const BODY = 10
const LINE = 1.42

const S = StyleSheet.create({
  page: { paddingTop: mm(9), paddingBottom: mm(8), paddingLeft: mm(7.5), paddingRight: mm(7.5), fontSize: BODY, lineHeight: LINE, color: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: mm(26), marginBottom: mm(1) },
  headerSide: { width: mm(40) },
  headerMid: { flex: 1, alignItems: 'center' },
  name: { fontSize: 18, lineHeight: 1.3, marginBottom: 2 },
  contact: { textAlign: 'center' },
  photo: { width: mm(20), height: mm(27), objectFit: 'cover', alignSelf: 'flex-end' },
  section: { marginTop: mm(2.6) },
  sectionTitle: { fontSize: 12.5, lineHeight: 1.3, paddingBottom: 1, marginBottom: mm(1), borderBottomWidth: 1.05, borderBottomColor: '#000', borderBottomStyle: 'solid' },
  entry: { marginTop: mm(1.7) },
  entryFirst: { marginTop: 0 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  rowLeft: { flex: 1, paddingRight: 8 },
  date: { flexShrink: 0 },
  bullet: { flexDirection: 'row', marginBottom: mm(0.45) },
  bulletDot: { width: 10, flexShrink: 0 },
  bulletText: { flex: 1 },
  line: { marginBottom: mm(0.45) },
})

interface Ctx { fonts: FontStack }

function T({ ctx, bold, style, children }: { ctx: Ctx; bold?: boolean; style?: object | object[]; children: unknown }) {
  const base = { fontFamily: bold ? ctx.fonts.bold : ctx.fonts.regular, fontWeight: bold ? 700 : 400 }
  const styles = Array.isArray(style) ? [base, ...style] : style ? [base, style] : [base]
  return <Text style={styles as never} hyphenationCallback={cjkHyphenation}>{children as never}</Text>
}

const BULLET_W = CLASSIC_CN.contentWidth - CLASSIC_CN.bulletIndent
const wrap = (s: string, width = CLASSIC_CN.contentWidth, bold = false) => wrapText(s, width, BODY, { bold }).join('\n')

function Bullets({ ctx, items }: { ctx: Ctx; items: string[] }) {
  return <>{items.filter(Boolean).map((b, i) => (
    <View key={i} style={S.bullet} wrap={false}>
      <T ctx={ctx} style={S.bulletDot}>•</T>
      <T ctx={ctx} style={S.bulletText}>{wrap(b, BULLET_W)}</T>
    </View>
  ))}</>
}

function EntryRow({ ctx, left, right, sub }: { ctx: Ctx; left: string; right?: string; sub?: string }) {
  return (
    <View style={S.row}>
      <View style={S.rowLeft}>
        <Text style={{ fontFamily: ctx.fonts.bold, fontWeight: 700 }} hyphenationCallback={cjkHyphenation}>
          {left}{sub ? <Text style={{ fontFamily: ctx.fonts.regular, fontWeight: 400 }}>{'  ' + sub}</Text> : null}
        </Text>
      </View>
      {right ? <T ctx={ctx} style={S.date}>{right}</T> : null}
    </View>
  )
}

function Section({ ctx, title, children }: { ctx: Ctx; title: string; children: unknown }) {
  return (
    <View style={S.section}>
      <T ctx={ctx} bold style={S.sectionTitle}>{title}</T>
      {children as never}
    </View>
  )
}

/** 技能行：粗体标签占了首行一部分宽度，所以第一行按剩余宽度折，后续行按整行折。 */
function wrapSkill(label: string, body: string): string {
  const labelW = measureText(label, BODY, true)
  const lines = wrapText(body, CLASSIC_CN.contentWidth - labelW, BODY)
  if (lines.length <= 1) return lines[0] ?? ''
  const rest = wrapText(lines.slice(1).join(''), CLASSIC_CN.contentWidth, BODY)
  return [lines[0], ...rest].join('\n')
}

function renderSection(ctx: Ctx, resume: Resume, key: SectionKey): ReactElement | null {
  const title = sectionTitle(resume, key)
  const entryStyle = (i: number) => (i === 0 ? [S.entry, S.entryFirst] : [S.entry])
  switch (key) {
    case 'education':
      if (!resume.education.length) return null
      return <Section ctx={ctx} title={title}>{resume.education.map((e, i) => (
        <View key={i} style={entryStyle(i)}>
          <EntryRow ctx={ctx} left={e.school} sub={[e.degree, e.major, e.gpa].filter(Boolean).join(' · ')} right={periodText(e.start, e.end)} />
          {e.courses.length ? <T ctx={ctx} style={S.line}>{wrap('核心课程：' + e.courses.join('、'))}</T> : null}
          <Bullets ctx={ctx} items={e.bullets} />
        </View>))}</Section>
    case 'experience':
      if (!resume.experience.length) return null
      return <Section ctx={ctx} title={title}>{resume.experience.map((e, i) => (
        <View key={i} style={entryStyle(i)}>
          <EntryRow ctx={ctx} left={e.org} sub={[e.department, e.position, e.location].filter(Boolean).join(' · ')} right={periodText(e.start, e.end)} />
          <Bullets ctx={ctx} items={e.bullets} />
          {e.roles.map((r, j) => (
            <View key={j} style={{ marginTop: mm(0.8) }}>
              <EntryRow ctx={ctx} left={r.position} right={periodText(r.start, r.end)} />
              <Bullets ctx={ctx} items={r.bullets} />
            </View>))}
        </View>))}</Section>
    case 'projects':
      if (!resume.projects.length) return null
      return <Section ctx={ctx} title={title}>{resume.projects.map((p, i) => (
        <View key={i} style={entryStyle(i)}>
          <EntryRow ctx={ctx} left={p.name} sub={[p.role, p.org, p.link].filter(Boolean).join(' · ')} right={periodText(p.start, p.end)} />
          <Bullets ctx={ctx} items={p.bullets} />
        </View>))}</Section>
    case 'skills':
      if (!resume.skills.length) return null
      return <Section ctx={ctx} title={title}>{resume.skills.map((s, i) => (
        <View key={i} style={S.line}>
          <Text style={{ fontFamily: ctx.fonts.regular }} hyphenationCallback={cjkHyphenation}>
            <Text style={{ fontFamily: ctx.fonts.bold, fontWeight: 700 }}>{s.name ? s.name + '：' : ''}</Text>
            {wrapSkill(s.name ? s.name + '：' : '', s.keywords.join('、') + (s.level ? `（${s.level}）` : ''))}
          </Text>
        </View>))}</Section>
    case 'awards':
      if (!resume.awards.length) return null
      return <Section ctx={ctx} title={title}>{resume.awards.map((a, i) => (
        <View key={i} style={S.line}>
          <EntryRow ctx={ctx} left={a.title} sub={[a.issuer, a.description].filter(Boolean).join(' · ')} right={a.date} />
        </View>))}</Section>
    case 'certifications':
      if (!resume.certifications.length) return null
      return <Section ctx={ctx} title={title}>
        <T ctx={ctx} style={S.line}>{wrap(resume.certifications.map(c => [c.title, c.issuer, c.date].filter(Boolean).join(' ')).join('；'))}</T>
      </Section>
    case 'custom_sections':
      if (!resume.custom_sections.some(s => s.items.length)) return null
      return <>{resume.custom_sections.filter(s => s.items.length).map((s, k) => (
        <Section key={k} ctx={ctx} title={s.title || title}>{s.items.map((it, i) => (
          <View key={i} style={entryStyle(i)}>
            {(it.title || it.date) ? <EntryRow ctx={ctx} left={it.title} sub={it.subtitle} right={it.date} /> : null}
            <Bullets ctx={ctx} items={it.bullets} />
          </View>))}</Section>))}</>
  }
}

export function ClassicCN({ resume, fonts }: { resume: Resume; fonts: FontStack }) {
  const ctx: Ctx = { fonts }
  const b = resume.basics
  const midW = CLASSIC_CN.contentWidth - 2 * CLASSIC_CN.headerSide
  const SEP = '  |  '
  const contactLines = [
    ...packSegments([b.phone, b.email, b.city], SEP, midW, BODY),
    ...packSegments([b.objective ? `求职意向：${b.objective}` : '', b.target_cities.length ? `期望城市：${b.target_cities.join('/')}` : '', b.expected_salary ? `期望薪资：${b.expected_salary}` : '', b.political_status ? `政治面貌：${b.political_status}` : '', b.availability ? `到岗：${b.availability}` : ''], SEP, midW, BODY),
    ...packSegments(b.links.filter(l => l.url).map(l => (l.label ? `${l.label}：${l.url}` : l.url)), SEP, midW, BODY),
  ]
  return (
    <Document title={`${b.name} 简历`} author={b.name} language="zh-CN">
      <Page size="A4" style={S.page}>
        <View style={S.header}>
          <View style={S.headerSide} />
          <View style={S.headerMid}>
            <T ctx={ctx} bold style={S.name}>{b.name || '姓名'}</T>
            {contactLines.map((line, i) => <T key={i} ctx={ctx} style={S.contact}>{line}</T>)}
          </View>
          <View style={S.headerSide}>{b.photo_url ? <Image src={b.photo_url} style={S.photo} /> : null}</View>
        </View>
        {orderedSections(resume).map(k => <View key={k}>{renderSection(ctx, resume, k)}</View>)}
      </Page>
    </Document>
  )
}

const TEMPLATES: Record<PdfTemplate, (p: { resume: Resume; fonts: FontStack }) => ReactElement> = { ClassicCN }

/** 渲染为 PDF Buffer。字体子集按简历文本按需注册。 */
export async function renderPdf(resume: Resume, opts: RenderPdfOptions = {}): Promise<Buffer> {
  const Template = TEMPLATES[opts.template ?? 'ClassicCN']
  if (!Template) throw new Error(`未知 PDF 模板：${opts.template}`)
  const fonts = fontStackFor(resumeText(resume) + '核心课程：求职意向：期望城市：期望薪资：政治面貌：到岗：姓名•')
  const buf = await renderToBuffer(<Template resume={resume} fonts={fonts} />)
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
}

/** 粗略统计 PDF 页数（按 /Type /Page 对象计数）。 */
export function countPdfPages(pdf: Buffer): number {
  const m = pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g)
  return m ? m.length : 0
}
