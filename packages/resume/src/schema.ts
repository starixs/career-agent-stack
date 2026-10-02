/**
 * 简历数据结构（中国求职场景精简版）。
 * 每个条目带 claim_ids，指回经历库的主张（claim）；没有主张支撑的内容在裁剪/保真检查时优先被怀疑。
 */
import { z } from 'zod'

const str = () => z.string().default('')
const strList = () => z.array(z.string()).default([])
const claimIds = () => z.array(z.string()).default([])

export const BasicsSchema = z.object({
  name: str(),
  phone: str(),
  email: str(),
  city: str(),                      // 现居城市
  target_cities: strList(),         // 期望城市
  expected_salary: str(),           // 期望薪资，如 "15-20K"
  political_status: str(),          // 政治面貌
  photo_url: str(),                 // 证件照（本地路径或 URL），空则不渲染
  objective: str(),                 // 求职意向
  availability: str(),              // 到岗时间 / 每周天数（可选）
  links: z.array(z.object({ label: str(), url: str() })).default([]),
})

export const EducationSchema = z.object({
  id: z.string().optional(),
  school: str(),
  degree: str(),                    // 本科 / 硕士
  major: str(),
  start: str(),                     // "2021.09"
  end: str(),                       // "2025.06" / "至今"
  gpa: str(),                       // 成绩或排名，成体系才放
  courses: strList(),               // 核心课程
  bullets: strList(),
  claim_ids: claimIds(),
})

export const RoleSchema = z.object({
  id: z.string().optional(),
  position: str(),
  start: str(),
  end: str(),
  bullets: strList(),
  claim_ids: claimIds(),
})

export const ExperienceSchema = z.object({
  id: z.string().optional(),
  org: str(),                       // 公司 / 组织
  position: str(),                  // 单一职位；多段轮岗用 roles
  department: str(),
  location: str(),
  start: str(),
  end: str(),
  bullets: strList(),
  roles: z.array(RoleSchema).default([]),
  claim_ids: claimIds(),
})

export const ProjectSchema = z.object({
  id: z.string().optional(),
  name: str(),
  role: str(),
  org: str(),
  start: str(),
  end: str(),
  link: str(),
  bullets: strList(),
  claim_ids: claimIds(),
})

export const SkillSchema = z.object({
  id: z.string().optional(),
  name: str(),                      // 分组名，如 "数据分析"
  level: str(),                     // 熟练 / 掌握 / 了解
  keywords: strList(),              // 具体工具/方法
  claim_ids: claimIds(),
})

export const AwardSchema = z.object({
  id: z.string().optional(),
  title: str(),
  issuer: str(),
  date: str(),
  description: str(),
  claim_ids: claimIds(),
})

export const CertificationSchema = z.object({
  id: z.string().optional(),
  title: str(),                     // 写法：已通过 FRM 一级，而不是 FRM 证书
  issuer: str(),
  date: str(),
  claim_ids: claimIds(),
})

export const CustomItemSchema = z.object({
  id: z.string().optional(),
  title: str(),
  subtitle: str(),
  date: str(),
  bullets: strList(),
  claim_ids: claimIds(),
})

export const CustomSectionSchema = z.object({
  id: z.string().optional(),
  title: str(),                     // 如 "校园与志愿" / "补充信息"
  items: z.array(CustomItemSchema).default([]),
})

export const SECTION_KEYS = ['education', 'experience', 'projects', 'skills', 'awards', 'certifications', 'custom_sections'] as const
export type SectionKey = typeof SECTION_KEYS[number]

export const SECTION_TITLES: Record<SectionKey, string> = {
  education: '教育背景',
  experience: '实习与工作经历',
  projects: '项目经历',
  skills: '专业技能',
  awards: '荣誉奖项',
  certifications: '证书',
  custom_sections: '补充信息',
}

export const ResumeSchema = z.object({
  version: z.literal(1).default(1),
  basics: BasicsSchema.default({}),
  education: z.array(EducationSchema).default([]),
  experience: z.array(ExperienceSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  awards: z.array(AwardSchema).default([]),
  certifications: z.array(CertificationSchema).default([]),
  custom_sections: z.array(CustomSectionSchema).default([]),
  /** 分区展示顺序；缺省按 SECTION_KEYS。 */
  section_order: z.array(z.enum(SECTION_KEYS)).default([...SECTION_KEYS]),
  /** 分区标题覆盖，如 { experience: '实习经历' }。 */
  section_titles: z.record(z.enum(SECTION_KEYS), z.string()).default({}),
})

export type Resume = z.infer<typeof ResumeSchema>
export type Basics = z.infer<typeof BasicsSchema>
export type Education = z.infer<typeof EducationSchema>
export type Experience = z.infer<typeof ExperienceSchema>
export type Role = z.infer<typeof RoleSchema>
export type Project = z.infer<typeof ProjectSchema>
export type Skill = z.infer<typeof SkillSchema>
export type Award = z.infer<typeof AwardSchema>
export type Certification = z.infer<typeof CertificationSchema>
export type CustomSection = z.infer<typeof CustomSectionSchema>
export type CustomItem = z.infer<typeof CustomItemSchema>

/** 空简历（所有字段取默认值）。 */
export function emptyResume(): Resume { return ResumeSchema.parse({}) }

/** 校验并补默认值；不合法时抛出中文错误。 */
export function parseResume(input: unknown): Resume {
  const r = ResumeSchema.safeParse(input)
  if (!r.success) throw new Error('简历数据不合法：' + r.error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('；'))
  return r.data
}

export function sectionTitle(resume: Resume, key: SectionKey): string {
  return resume.section_titles[key] ?? SECTION_TITLES[key]
}

/** 分区顺序：section_order 里出现的在前，未列出的补在后面。 */
export function orderedSections(resume: Resume): SectionKey[] {
  const seen = new Set<SectionKey>()
  const out: SectionKey[] = []
  for (const k of [...resume.section_order, ...SECTION_KEYS]) if (!seen.has(k)) { seen.add(k); out.push(k) }
  return out
}

export interface BulletRef { path: string; section: SectionKey; entry: string; text: string; claim_ids: string[] }

/** 列出全部 bullet（JSON Pointer 路径 + 所属条目），供打分、裁剪、保真检查复用。 */
export function listBullets(resume: Resume): BulletRef[] {
  const out: BulletRef[] = []
  const push = (path: string, section: SectionKey, entry: string, bullets: string[], claim_ids: string[]) =>
    bullets.forEach((text, i) => out.push({ path: `${path}/bullets/${i}`, section, entry, text, claim_ids }))
  resume.education.forEach((e, i) => push(`/education/${i}`, 'education', e.school, e.bullets, e.claim_ids))
  resume.experience.forEach((e, i) => {
    push(`/experience/${i}`, 'experience', `${e.org} ${e.position}`.trim(), e.bullets, e.claim_ids)
    e.roles.forEach((r, j) => push(`/experience/${i}/roles/${j}`, 'experience', `${e.org} ${r.position}`.trim(), r.bullets, r.claim_ids))
  })
  resume.projects.forEach((p, i) => push(`/projects/${i}`, 'projects', p.name, p.bullets, p.claim_ids))
  resume.custom_sections.forEach((s, i) => s.items.forEach((it, j) => push(`/custom_sections/${i}/items/${j}`, 'custom_sections', `${s.title} ${it.title}`.trim(), it.bullets, it.claim_ids)))
  return out
}

/** 简历里所有可读文本（拼成一段），用于字体子集计算与保真比对。 */
export function resumeText(resume: Resume): string {
  const parts: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'claim_ids' && k !== 'id' && k !== 'photo_url') walk(x) })
  }
  walk(resume)
  return parts.join('\n')
}

/** 日期区间显示："2023.07-2023.09"，缺省端用 "至今"。 */
export function periodText(start: string, end: string): string {
  if (!start && !end) return ''
  return `${start || ''}${start || end ? ' - ' : ''}${end || '至今'}`
}
