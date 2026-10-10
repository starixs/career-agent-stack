import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { listSkills, loadSkill, skillPrompt } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const SKILLS_ROOT = resolve(here, '../../../skills')

/** 产品内置的 24 个求职技能（名称固定）；memory-extract / memory-consolidate 是后台长期记忆用的。 */
const EXPECTED = [
  'assistant-core', 'experience-interview', 'jd-parse', 'resume-draft', 'resume-tailor', 'derivatives',
  'job-evaluate', 'company-research', 'apply-playbook', 'greeting', 'interview-probe',
  'interview-questions', 'project-story', 'probe-predict', 'interview-retro',
  'direction-explore', 'gap-plan', 'offer-compare', 'campus-timeline',
  'inbox-triage', 'weekly-review', 'material-draft',
  'memory-extract', 'memory-consolidate',
] as const

/** 必须带 references 的技能及其最少文件数。 */
const EXPECTED_REFS: Record<string, number> = {
  'experience-interview': 8,
  'resume-tailor': 3,
  'company-research': 3,
  'interview-probe': 4,
  'interview-questions': 12,
  'interview-retro': 21,
}

describe('内置技能包', () => {
  const metas = listSkills(SKILLS_ROOT)

  it('24 个技能目录都存在且名称固定', () => {
    const names = metas.map(m => m.name).sort()
    expect(names).toEqual([...EXPECTED].sort())
    expect(metas.length).toBe(24)
  })

  it('frontmatter 完整：name / description / triggers（中文触发词，非空）', () => {
    for (const m of metas) {
      expect(m.name, m.dir).toMatch(/^[a-z][a-z-]+$/)
      expect(m.description.length, `${m.name} description`).toBeGreaterThan(10)
      expect(m.triggers.length, `${m.name} triggers`).toBeGreaterThan(0)
      // 触发词里至少要有中文，便于按用户话术命中
      expect(m.triggers.some(t => /[一-鿿]/.test(t)), `${m.name} 需要中文触发词`).toBe(true)
      for (const t of m.triggers) expect(t.trim().length, `${m.name} 空触发词`).toBeGreaterThan(0)
    }
  })

  it('frontmatter 的 name 与目录名一致', () => {
    for (const m of metas) expect(m.dir.split('/').pop()).toBe(m.name)
  })

  it('每个 SKILL.md 正文包含"输出"与"约束"字样，正文长度在 300–800 字之间', () => {
    for (const name of EXPECTED) {
      const s = loadSkill(SKILLS_ROOT, name)
      expect(s.body, `${name} 缺少"输出"`).toContain('输出')
      expect(s.body, `${name} 缺少"约束"`).toContain('约束')
      const cjk = (s.body.match(/[一-鿿]/g) ?? []).length
      expect(cjk, `${name} 正文 ${cjk} 字`).toBeGreaterThanOrEqual(300)
      expect(cjk, `${name} 正文 ${cjk} 字`).toBeLessThanOrEqual(800)
    }
  })

  it('skillPrompt 能拼出 system prompt 文本，并可按名挂载 references', () => {
    for (const name of EXPECTED) {
      const s = loadSkill(SKILLS_ROOT, name)
      const base = skillPrompt(s)
      expect(base.startsWith(`# 技能：${name}`), name).toBe(true)
      expect(base.length).toBeGreaterThan(s.body.trim().length)
      const refNames = Object.keys(s.references)
      const withRefs = skillPrompt(s, refNames)
      for (const r of refNames) {
        expect(withRefs, `${name} 未挂载 ${r}`).toContain(`## 参考：${r}`)
        expect(s.references[r].trim().length, `${name}/references/${r}.md 为空`).toBeGreaterThan(200)
      }
      // 不存在的 reference 被静默忽略
      expect(skillPrompt(s, ['__不存在__'])).toBe(base)
    }
  })

  it('需要手册的技能带齐 references', () => {
    for (const [name, min] of Object.entries(EXPECTED_REFS)) {
      const s = loadSkill(SKILLS_ROOT, name)
      expect(Object.keys(s.references).length, `${name} references`).toBeGreaterThanOrEqual(min)
    }
    const retro = loadSkill(SKILLS_ROOT, 'interview-retro')
    for (const r of ['标签词表', '题型诊断', '轮次判定', '归档格式']) expect(retro.references).toHaveProperty(r)
    expect(retro.references['标签词表']).toContain('no_feedback')
    expect(retro.body).toContain('no_feedback_inferred')
    const probe = loadSkill(SKILLS_ROOT, 'interview-probe')
    for (const r of ['大厂', '创业公司', '国企央企', '外企']) expect(probe.references).toHaveProperty(r)
  })

  it('技能正文不引用旧模块的内部路径', () => {
    for (const name of EXPECTED) {
      const raw = readFileSync(resolve(SKILLS_ROOT, name, 'SKILL.md'), 'utf8')
      expect(raw, name).not.toMatch(/CAREER_ROOT|SKILL_ROOT|patterns\/|data_fetcher|modules\//)
    }
  })
})
