import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 技能 = 一个目录：SKILL.md（frontmatter: name/description/triggers）+ 可选 references/*.md。
 * 加载后以 system prompt 片段的形式注入模型；不执行任何代码。
 */
export interface SkillMeta { name: string; description: string; triggers: string[]; dir: string }
export interface Skill extends SkillMeta { body: string; references: Record<string, string> }

export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: md.slice(m[0].length) }
}

export function listSkills(root: string): SkillMeta[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map(name => join(root, name))
    .filter(dir => statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md')))
    .map(dir => {
      const { meta } = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      return { name: meta.name ?? dir.split('/').pop()!, description: meta.description ?? '', triggers: (meta.triggers ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean), dir }
    })
}

export function loadSkill(root: string, name: string): Skill {
  const dir = join(root, name)
  const { meta, body } = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  const references: Record<string, string> = {}
  const refDir = join(dir, 'references')
  if (existsSync(refDir)) for (const f of readdirSync(refDir)) if (f.endsWith('.md')) references[f.replace(/\.md$/, '')] = readFileSync(join(refDir, f), 'utf8')
  return { name: meta.name ?? name, description: meta.description ?? '', triggers: (meta.triggers ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean), dir, body, references }
}

/** 把技能正文 + 指定 references 拼成 system prompt。 */
export function skillPrompt(skill: Skill, refs: string[] = []): string {
  const parts = [`# 技能：${skill.name}\n${skill.body.trim()}`]
  for (const r of refs) if (skill.references[r]) parts.push(`\n\n## 参考：${r}\n${skill.references[r].trim()}`)
  return parts.join('\n')
}
