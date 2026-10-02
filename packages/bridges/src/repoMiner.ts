/**
 * 代码证据挖掘（纯 TypeScript，不依赖 Python）。
 * 参考 modules/repo-miner 的三分法与真实性 checklist：
 *   - 每条主张必附证据（commit hash 或 file:line@hash），找不到出处的删掉；
 *   - "项目用了 X" ≠ "我做了 X"：个人贡献需要本人提交占比支撑；
 *   - 量化数据（性能 %、QPS、用户数）代码不能证明的一律进"待确认"，不编数字；
 *   - 证据强度：强 = 代码/提交里有明确实现；中 = 有迹象需推断；弱 = 仅从结构/依赖推测。
 *
 * 规则（代码里强制，不只靠提示词）：贡献者数为 1 或本人提交占比 ≥ 70% 才允许 attribution=self 的强证据。
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { extractJson, type LLM, type Repos, type Claim, type Evidence } from '@career/core'

export type GitRunner = (args: string[], cwd: string) => Promise<string>

export const defaultGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) reject(new Error(`git ${args.slice(0, 2).join(' ')} 失败：${String(stderr || err.message).trim()}`))
    else resolve(String(stdout))
  })
})

export interface Contributor { name: string; email: string; commits: number }
export interface FileActivity { path: string; commits: number; added: number; deleted: number; authorCommits: number; authorAdded: number; authorDeleted: number }
export interface BlameSample { path: string; authorLines: number; totalLines: number; share: number }
export interface CommitBrief { hash: string; short: string; author: string; date: string; subject: string; files: string[]; added: number; deleted: number }

export interface TechStack {
  languages: Record<string, number>
  dependencies: string[]
  frameworks: string[]
  readmeExcerpt: string | null
  projectName: string | null
  description: string | null
}

export interface RepoStats {
  repoPath: string
  head: string
  author: string
  totalCommits: number
  authorCommits: number
  authorShare: number
  contributorCount: number
  contributors: Contributor[]
  totalAdded: number
  totalDeleted: number
  authorAdded: number
  authorDeleted: number
  firstDate: string | null
  lastDate: string | null
  authorFirstDate: string | null
  authorLastDate: string | null
  activeFiles: FileActivity[]
  blameSamples: BlameSample[]
  blameShare: number | null
  authorCommitList: CommitBrief[]
  /** 贡献者=1 或本人占比≥70%：允许 attribution=self 的强证据。 */
  selfAllowed: boolean
}

export type EvidenceKind = 'commit' | 'code'
export type Strength = 'strong' | 'mid' | 'weak'
export interface MineEvidence { kind: EvidenceKind; locator: string; strength: Strength; excerpt?: string | null }
export interface MineClaim {
  text: string
  attribution: 'self' | 'team' | 'unknown'
  result_metric: string | null
  evidence: MineEvidence[]
  /** 需要本人确认的点（量化数据 / 角色 / 规模）。 */
  needs_confirmation: string[]
}
export interface MineResult { stats: RepoStats; techStack: TechStack; claims: MineClaim[]; notes: string[]; dropped: Array<{ text: string; reason: string }> }

export interface MineOptions {
  author?: string | RegExp
  llm: LLM
  jd?: string
  /** 活跃文件数上限（送给模型）。 */
  maxFiles?: number
  /** blame 抽样文件数。 */
  blameSamples?: number
  git?: GitRunner
  maxClaims?: number
}

const SELF_SHARE_THRESHOLD = 0.7
const ROLE_WORDS = /(独立|主导|自研|从零|精通|负责整个|全栈独立|一个人)/
const GENERATED_PATTERNS = [/(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)vendor\//, /\.lock$/, /-lock\.(json|yaml)$/, /\.min\.(js|css)$/, /(^|\/)__pycache__\//, /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|pdf)$/i]
const isGenerated = (p: string) => GENERATED_PATTERNS.some(re => re.test(p))

// ── git 统计 ─────────────────────────────────────────────────────────────

interface RawCommit { hash: string; name: string; email: string; date: string; subject: string; files: Array<{ path: string; added: number; deleted: number }> }

function parseNumstatLog(text: string): RawCommit[] {
  const out: RawCommit[] = []
  let cur: RawCommit | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('\u0001')) {
      const [hash, name, email, date, subject] = line.slice(1).split('\u001f')
      cur = { hash, name, email, date, subject: subject ?? '', files: [] }
      out.push(cur)
    } else if (cur && line.trim()) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      cur.files.push({ path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) })
    }
  }
  return out
}

function matchAuthor(matcher: string | RegExp, name: string, email: string): boolean {
  const ident = `${name} <${email}>`
  if (matcher instanceof RegExp) return matcher.test(ident)
  const m = matcher.trim().toLowerCase()
  return !!m && (name.toLowerCase() === m || email.toLowerCase() === m || ident.toLowerCase().includes(m))
}

/** 解析本人身份：显式传入 > 仓库 git config user.name/email > 提交最多的人。 */
async function resolveAuthor(git: GitRunner, repoPath: string, explicit: string | RegExp | undefined, contributors: Contributor[]): Promise<{ matcher: string | RegExp; label: string }> {
  if (explicit) return { matcher: explicit, label: explicit instanceof RegExp ? explicit.source : explicit }
  const name = (await git(['config', 'user.name'], repoPath).catch(() => '')).trim()
  const email = (await git(['config', 'user.email'], repoPath).catch(() => '')).trim()
  if (email && contributors.some(c => c.email.toLowerCase() === email.toLowerCase())) return { matcher: email, label: `${name || email} <${email}>` }
  if (name && contributors.some(c => c.name === name)) return { matcher: name, label: name }
  if (contributors.length) return { matcher: contributors[0].email || contributors[0].name, label: `${contributors[0].name} <${contributors[0].email}>（按提交数推断，请确认）` }
  return { matcher: name || email || '', label: name || email || '未知' }
}

export async function collectRepoStats(repoPath: string, opts: { author?: string | RegExp; git?: GitRunner; maxFiles?: number; blameSamples?: number } = {}): Promise<RepoStats> {
  const git = opts.git ?? defaultGit
  await git(['rev-parse', '--is-inside-work-tree'], repoPath).catch(() => { throw new Error(`不是 git 仓库：${repoPath}`) })
  const head = (await git(['rev-parse', 'HEAD'], repoPath)).trim()

  // git shortlog -sne：贡献者与提交数
  const shortlog = await git(['shortlog', '-sne', '--no-merges', 'HEAD'], repoPath)
  const contributors: Contributor[] = shortlog.split('\n').map(l => l.match(/^\s*(\d+)\t(.*?)\s*<([^>]*)>\s*$/)).filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ commits: Number(m[1]), name: m[2], email: m[3] })).sort((a, b) => b.commits - a.commits)

  const { matcher, label } = await resolveAuthor(git, repoPath, opts.author, contributors)

  // git log --numstat：一次拿到每个提交的作者、日期、改动文件
  const log = await git(['log', '--no-merges', '--date=short', '--format=\u0001%H\u001f%an\u001f%ae\u001f%ad\u001f%s', '--numstat', 'HEAD'], repoPath)
  const commits = parseNumstatLog(log)
  const authorCommitsRaw = commits.filter(c => matchAuthor(matcher, c.name, c.email))

  // git log --author：用它校验（与上面的匹配取并集，避免 shortlog/映射差异）
  if (typeof matcher === 'string' && matcher) {
    const byAuthor = (await git(['log', '--no-merges', '--format=%H', `--author=${matcher}`, 'HEAD'], repoPath).catch(() => '')).split('\n').filter(Boolean)
    const known = new Set(authorCommitsRaw.map(c => c.hash))
    for (const h of byAuthor) { const c = commits.find(x => x.hash === h); if (c && !known.has(h)) { authorCommitsRaw.push(c); known.add(h) } }
  }
  const authorHashes = new Set(authorCommitsRaw.map(c => c.hash))

  const files = new Map<string, FileActivity>()
  let totalAdded = 0, totalDeleted = 0, authorAdded = 0, authorDeleted = 0
  for (const c of commits) {
    const mine = authorHashes.has(c.hash)
    for (const f of c.files) {
      if (isGenerated(f.path)) continue
      const fa = files.get(f.path) ?? { path: f.path, commits: 0, added: 0, deleted: 0, authorCommits: 0, authorAdded: 0, authorDeleted: 0 }
      fa.commits++; fa.added += f.added; fa.deleted += f.deleted
      totalAdded += f.added; totalDeleted += f.deleted
      if (mine) { fa.authorCommits++; fa.authorAdded += f.added; fa.authorDeleted += f.deleted; authorAdded += f.added; authorDeleted += f.deleted }
      files.set(f.path, fa)
    }
  }
  const activeFiles = [...files.values()].sort((a, b) => (b.authorCommits * 1000 + b.authorAdded) - (a.authorCommits * 1000 + a.authorAdded) || b.commits - a.commits).slice(0, opts.maxFiles ?? 30)

  const dates = commits.map(c => c.date).filter(Boolean).sort()
  const aDates = authorCommitsRaw.map(c => c.date).filter(Boolean).sort()

  // git blame 抽样：在本人改动最多且仍存在的文件里数本人行数
  const blameSamples: BlameSample[] = []
  const candidates = activeFiles.filter(f => f.authorCommits > 0).slice(0, opts.blameSamples ?? 6)
  for (const f of candidates) {
    try {
      await stat(join(repoPath, f.path))
      const blame = await git(['blame', '--line-porcelain', 'HEAD', '--', f.path], repoPath)
      let total = 0, mine = 0, curName = '', curMail = ''
      for (const line of blame.split('\n')) {
        if (line.startsWith('author ')) curName = line.slice(7)
        else if (line.startsWith('author-mail ')) curMail = line.slice(12).replace(/^<|>$/g, '')
        else if (line.startsWith('\t')) { total++; if (matchAuthor(matcher, curName, curMail)) mine++ }
      }
      if (total > 0) blameSamples.push({ path: f.path, authorLines: mine, totalLines: total, share: Math.round((mine / total) * 1000) / 1000 })
    } catch { /* 二进制或已删除，跳过 */ }
  }
  const blameTotal = blameSamples.reduce((s, b) => s + b.totalLines, 0)
  const blameShare = blameTotal ? Math.round((blameSamples.reduce((s, b) => s + b.authorLines, 0) / blameTotal) * 1000) / 1000 : null

  const totalCommits = commits.length
  const authorShare = totalCommits ? Math.round((authorCommitsRaw.length / totalCommits) * 1000) / 1000 : 0
  const contributorCount = contributors.length || new Set(commits.map(c => c.email)).size

  const authorCommitList: CommitBrief[] = authorCommitsRaw.map(c => ({
    hash: c.hash, short: c.hash.slice(0, 7), author: c.name, date: c.date, subject: c.subject,
    files: c.files.filter(f => !isGenerated(f.path)).map(f => f.path).slice(0, 8),
    added: c.files.reduce((s, f) => s + f.added, 0), deleted: c.files.reduce((s, f) => s + f.deleted, 0),
  }))

  return {
    repoPath, head, author: label, totalCommits, authorCommits: authorCommitsRaw.length, authorShare, contributorCount, contributors,
    totalAdded, totalDeleted, authorAdded, authorDeleted,
    firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null,
    authorFirstDate: aDates[0] ?? null, authorLastDate: aDates[aDates.length - 1] ?? null,
    activeFiles, blameSamples, blameShare, authorCommitList,
    selfAllowed: contributorCount === 1 || authorShare >= SELF_SHARE_THRESHOLD,
  }
}

// ── 技术栈识别 ────────────────────────────────────────────────────────────

const LANG_BY_EXT: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C/C++', '.cc': 'C++', '.cpp': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.scala': 'Scala', '.sql': 'SQL', '.sh': 'Shell', '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart', '.lua': 'Lua', '.r': 'R', '.m': 'Objective-C' }
const FRAMEWORK_HINTS: Array<[RegExp, string]> = [
  [/^react$/, 'React'], [/^vue$/, 'Vue'], [/^next$/, 'Next.js'], [/^nuxt$/, 'Nuxt'], [/^svelte$/, 'Svelte'], [/^express$/, 'Express'], [/^koa$/, 'Koa'], [/^fastify$/, 'Fastify'], [/^nestjs|^@nestjs\//, 'NestJS'], [/^electron$/, 'Electron'], [/^vite$/, 'Vite'], [/^webpack$/, 'Webpack'], [/^playwright/, 'Playwright'], [/^puppeteer/, 'Puppeteer'], [/^jest$|^vitest$|^mocha$/, '单元测试'], [/^prisma|^@prisma\//, 'Prisma'], [/^typeorm$/, 'TypeORM'], [/^mongoose$/, 'MongoDB'], [/^pg$|^postgres/, 'PostgreSQL'], [/^mysql2?$/, 'MySQL'], [/^redis$|^ioredis$/, 'Redis'], [/^kafkajs$/, 'Kafka'], [/^zod$/, 'Zod'], [/^tailwindcss$/, 'Tailwind'],
  [/^django$/i, 'Django'], [/^flask$/i, 'Flask'], [/^fastapi$/i, 'FastAPI'], [/^torch$/i, 'PyTorch'], [/^tensorflow$/i, 'TensorFlow'], [/^pandas$/i, 'pandas'], [/^numpy$/i, 'NumPy'], [/^scikit-learn$|^sklearn$/i, 'scikit-learn'], [/^sqlalchemy$/i, 'SQLAlchemy'], [/^celery$/i, 'Celery'], [/^pydantic$/i, 'Pydantic'], [/^langchain/i, 'LangChain'], [/^transformers$/i, 'Transformers'], [/^scrapy$/i, 'Scrapy'], [/^requests$|^httpx$/i, 'HTTP 客户端'], [/^pytest$/i, 'pytest'],
  [/^gin-gonic\/gin$|\/gin$/, 'Gin'], [/gorm/, 'GORM'], [/^actix|^axum$|^tokio$/, 'Rust 异步'], [/spring/i, 'Spring'],
]

export async function detectTechStack(repoPath: string, git: GitRunner = defaultGit): Promise<TechStack> {
  const tracked = (await git(['ls-files'], repoPath).catch(() => '')).split('\n').filter(p => p && !isGenerated(p))
  const languages: Record<string, number> = {}
  for (const p of tracked) { const l = LANG_BY_EXT[extname(p).toLowerCase()]; if (l) languages[l] = (languages[l] ?? 0) + 1 }
  const deps = new Set<string>()
  let projectName: string | null = null, description: string | null = null
  const readText = async (p: string) => readFile(join(repoPath, p), 'utf8').catch(() => null)

  const pkg = await readText('package.json')
  if (pkg) { try { const j = JSON.parse(pkg) as { name?: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }; projectName = j.name ?? null; description = j.description ?? null; for (const k of Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) })) deps.add(k) } catch { /* 忽略坏 JSON */ } }
  const pyproject = await readText('pyproject.toml')
  if (pyproject) {
    const name = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m); if (name && !projectName) projectName = name[1]
    const desc = pyproject.match(/^\s*description\s*=\s*"([^"]+)"/m); if (desc && !description) description = desc[1]
    const depBlock = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
    if (depBlock) for (const m of depBlock[1].matchAll(/"([A-Za-z0-9_.-]+)/g)) deps.add(m[1].toLowerCase())
  }
  const req = await readText('requirements.txt')
  if (req) for (const line of req.split('\n')) { const m = line.trim().match(/^([A-Za-z0-9_.-]+)/); if (m && !line.startsWith('#')) deps.add(m[1].toLowerCase()) }
  const gomod = await readText('go.mod')
  if (gomod) { const mod = gomod.match(/^module\s+(\S+)/m); if (mod && !projectName) projectName = mod[1]; for (const m of gomod.matchAll(/^\s+(\S+)\s+v[\d.]+/gm)) deps.add(m[1]) }
  const cargo = await readText('Cargo.toml')
  if (cargo) { const name = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m); if (name && !projectName) projectName = name[1]; const block = cargo.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/); if (block) for (const m of block[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) deps.add(m[1]) }

  let readmeExcerpt: string | null = null
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README']) { const t = await readText(name); if (t) { readmeExcerpt = t.slice(0, 3000); break } }
  const frameworks = [...new Set([...deps].flatMap(d => FRAMEWORK_HINTS.filter(([re]) => re.test(d)).map(([, n]) => n)))]
  return { languages, dependencies: [...deps].slice(0, 80), frameworks, readmeExcerpt, projectName, description }
}

// ── LLM 生成 + 规则校验 ───────────────────────────────────────────────────

const ClaimOut = z.object({
  text: z.string().min(2),
  attribution: z.enum(['self', 'team', 'unknown']).default('unknown'),
  result_metric: z.string().nullable().optional(),
  evidence: z.array(z.object({ kind: z.enum(['commit', 'code']), locator: z.string(), strength: z.enum(['strong', 'mid', 'weak']).default('mid'), excerpt: z.string().nullable().optional() })).default([]),
  needs_confirmation: z.array(z.string()).default([]),
})
const LlmOut = z.object({ claims: z.array(ClaimOut).default([]), notes: z.array(z.string()).default([]) })

export function buildMinePrompt(stats: RepoStats, tech: TechStack, jd?: string): { system: string; user: string } {
  const system = `你是"代码证据挖掘"助手，任务是从 git 事实里提炼可写进简历的主张（claim），并给每条主张挂证据。只输出 JSON。

铁律（违反即作废）：
1. "项目用了 X" ≠ "我做了 X"。只能根据本人提交（下面列出的 hash）与 blame 数据判断个人贡献；仓库里出现某个库/框架只能说明项目使用了它。
2. attribution 三分法：self = 本人提交直接实现；team = 项目/团队成果、本人参与但无法单独归功；unknown = 无法从提交判断。
3. 每条主张必须至少一条证据：kind=commit 用完整 commit hash 做 locator（只能用下面列出的本人 hash）；kind=code 用 "路径:行号@<hash>" 或 "路径@<hash>"（路径必须在下面的活跃文件列表里）。找不到证据的主张不要写。
4. 证据强度：strong = 提交/代码里有明确实现；mid = 有迹象需推断；weak = 仅从结构/依赖推测。本人占比不足 70% 且贡献者多于 1 人时，attribution 不得为 self，强度最高 mid。
5. 量化数据（性能提升 %、QPS、用户数、节省工时…）除非提交信息或代码里写明，否则 result_metric 填 null，并把需要本人确认的内容写进 needs_confirmation。绝不编造数字。
6. 用词诚实：按证据强度选"参与 / 负责 / 主导 / 独立完成"，用了开源框架就不说"自研"；不用"高并发 / 百万级 / 海量 / 业界领先"等无数据修饰词。
7. 主张用中文，一句话，动词开头，面向简历；最多 ${8} 条，按证据强度与岗位相关度排序。

输出格式：{"claims":[{"text":"...","attribution":"self|team|unknown","result_metric":null,"evidence":[{"kind":"commit","locator":"<hash>","strength":"strong","excerpt":"提交信息或代码片段"}],"needs_confirmation":["..."]}],"notes":["..."]}`

  const lines: string[] = []
  lines.push(`# 仓库事实`)
  lines.push(`- 路径：${stats.repoPath}；HEAD ${stats.head.slice(0, 7)}`)
  lines.push(`- 项目：${tech.projectName ?? '未知'}${tech.description ? `（${tech.description}）` : ''}`)
  lines.push(`- 语言分布（按文件数）：${Object.entries(tech.languages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，') || '未知'}`)
  lines.push(`- 识别到的框架/库：${tech.frameworks.join('，') || '无'}；依赖（节选）：${tech.dependencies.slice(0, 40).join(', ') || '无'}`)
  lines.push(`- 提交总数 ${stats.totalCommits}，贡献者 ${stats.contributorCount} 人：${stats.contributors.slice(0, 8).map(c => `${c.name}(${c.commits})`).join('，')}`)
  lines.push(`- 本人身份：${stats.author}；本人提交 ${stats.authorCommits}（占比 ${(stats.authorShare * 100).toFixed(0)}%），改动 +${stats.authorAdded}/-${stats.authorDeleted}（仓库总 +${stats.totalAdded}/-${stats.totalDeleted}）`)
  lines.push(`- 时间跨度：仓库 ${stats.firstDate ?? '?'} ~ ${stats.lastDate ?? '?'}；本人 ${stats.authorFirstDate ?? '?'} ~ ${stats.authorLastDate ?? '?'}`)
  lines.push(`- blame 抽样（本人行数/总行数）：${stats.blameSamples.map(b => `${b.path} ${b.authorLines}/${b.totalLines}`).join('；') || '无'}${stats.blameShare != null ? `，合计占比 ${(stats.blameShare * 100).toFixed(0)}%` : ''}`)
  lines.push(`- 是否允许 self + strong：${stats.selfAllowed ? '允许（贡献者=1 或本人占比≥70%）' : '不允许（请用 team/unknown，强度≤mid）'}`)
  lines.push(``)
  lines.push(`# 本人提交（只能引用这些 hash）`)
  for (const c of stats.authorCommitList.slice(0, 60)) lines.push(`- ${c.hash} ${c.date} ${c.subject} [+${c.added}/-${c.deleted}] ${c.files.join(', ')}`)
  lines.push(``)
  lines.push(`# 活跃文件（本人提交次数/总提交次数，本人 +/-）`)
  for (const f of stats.activeFiles) lines.push(`- ${f.path}：${f.authorCommits}/${f.commits}，+${f.authorAdded}/-${f.authorDeleted}`)
  if (tech.readmeExcerpt) { lines.push(``, `# README 节选`, tech.readmeExcerpt.slice(0, 2000)) }
  if (jd) { lines.push(``, `# 目标岗位 JD（排序参考，不得据此编造经历）`, jd.slice(0, 2000)) }
  return { system, user: lines.join('\n') }
}

const HASH_RE = /^[0-9a-f]{7,40}$/i

/** 把模型输出按规则校验：hash 必须是本人提交、路径必须真实、self/strong 受占比限制、量化数据进待确认。 */
export function enforceRules(raw: z.infer<typeof LlmOut>, stats: RepoStats, maxClaims = 8): { claims: MineClaim[]; dropped: Array<{ text: string; reason: string }>; notes: string[] } {
  const notes: string[] = [...raw.notes]
  const dropped: Array<{ text: string; reason: string }> = []
  const authorHashes = new Map(stats.authorCommitList.map(c => [c.hash, c]))
  const shortIndex = new Map(stats.authorCommitList.map(c => [c.short, c]))
  const files = new Set(stats.activeFiles.map(f => f.path))
  const resolveHash = (h: string) => authorHashes.get(h) ?? shortIndex.get(h.slice(0, 7)) ?? [...authorHashes.values()].find(c => c.hash.startsWith(h))

  const claims: MineClaim[] = []
  for (const c of raw.claims) {
    const needs = new Set(c.needs_confirmation)
    const evidence: MineEvidence[] = []
    for (const ev of c.evidence) {
      let locator = ev.locator.trim()
      let ok = false
      if (ev.kind === 'commit') {
        const found = HASH_RE.test(locator) ? resolveHash(locator) : undefined
        if (found) { locator = found.hash; ok = true }
      } else {
        const m = locator.match(/^(.+?)(?::(\d+(?:-\d+)?))?(?:@([0-9a-f]{7,40}))?$/i)
        if (m && files.has(m[1])) {
          const found = m[3] ? resolveHash(m[3]) : undefined
          const hash = found?.hash ?? stats.head
          locator = `${m[1]}${m[2] ? `:${m[2]}` : ''}@${hash}`
          ok = !!(found || !m[3])
        }
      }
      if (!ok) { notes.push(`证据定位无法核实，已丢弃：${ev.kind} ${ev.locator}`); continue }
      let strength: Strength = ev.strength
      if (!stats.selfAllowed && strength === 'strong') strength = 'mid'
      evidence.push({ kind: ev.kind, locator, strength, excerpt: ev.excerpt ?? null })
    }
    if (evidence.length === 0) { dropped.push({ text: c.text, reason: '没有可核实的证据（commit hash 不是本人提交，或路径不在仓库里）' }); continue }

    let attribution = c.attribution
    if (attribution === 'self' && !stats.selfAllowed) {
      attribution = 'team'
      needs.add(`本人提交占比 ${(stats.authorShare * 100).toFixed(0)}%（贡献者 ${stats.contributorCount} 人），请确认该项是否由你本人完成`)
    }
    if (attribution !== 'self' && ROLE_WORDS.test(c.text)) needs.add('表述涉及个人角色（独立/主导/自研等），需本人确认')
    if (stats.contributorCount === 1 && attribution === 'self') needs.add('贡献者=1 可能是 squash 合并的结果，请确认时间跨度与是否有协作')

    let metric = c.result_metric?.trim() || null
    if (metric) {
      const digits = metric.match(/\d+(?:\.\d+)?/g) ?? []
      const corpus = [...stats.authorCommitList.map(x => x.subject), ...evidence.map(e => e.excerpt ?? '')].join('\n')
      const provable = digits.length > 0 && digits.every(d => corpus.includes(d))
      if (!provable) { needs.add(`量化数据"${metric}"代码无法证明，需本人确认`); metric = null }
    }
    claims.push({ text: c.text.trim(), attribution, result_metric: metric, evidence, needs_confirmation: [...needs] })
  }
  const order: Record<Strength, number> = { strong: 0, mid: 1, weak: 2 }
  claims.sort((a, b) => order[a.evidence[0].strength] - order[b.evidence[0].strength])
  return { claims: claims.slice(0, maxClaims), dropped, notes }
}

/** 主入口：git 统计 → 技术栈 → 模型提炼 → 规则校验。 */
export async function mineRepo(repoPath: string, opts: MineOptions): Promise<MineResult> {
  const git = opts.git ?? defaultGit
  const stats = await collectRepoStats(repoPath, { author: opts.author, git, maxFiles: opts.maxFiles, blameSamples: opts.blameSamples })
  const techStack = await detectTechStack(repoPath, git)
  if (stats.authorCommits === 0) {
    return { stats, techStack, claims: [], dropped: [], notes: [`仓库里没有匹配"${stats.author}"的提交，无法提炼个人贡献；请传入正确的 author（姓名或邮箱）。`] }
  }
  const { system, user } = buildMinePrompt(stats, techStack, opts.jd)
  const res = await opts.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.2 })
  let parsed: z.infer<typeof LlmOut>
  try { parsed = LlmOut.parse(extractJson(res.text)) } catch (e) { throw new Error(`模型输出不是合法的 claims JSON：${(e as Error).message}`) }
  const { claims, dropped, notes } = enforceRules(parsed, stats, opts.maxClaims)
  if (!stats.selfAllowed) notes.unshift(`本人提交占比 ${(stats.authorShare * 100).toFixed(0)}%，贡献者 ${stats.contributorCount} 人：所有主张按团队成果处理，证据强度最高 mid。`)
  return { stats, techStack, claims, dropped, notes }
}

/** 把挖掘结果写进 claim/evidence 表；status 一律 pending，created_from=repo。 */
export function importMineResult(repos: Repos, experienceId: string, result: Pick<MineResult, 'claims'>): { claims: Claim[]; evidence: Evidence[] } {
  const claims: Claim[] = []; const evidence: Evidence[] = []
  repos.db.transaction(() => {
    for (const c of result.claims) {
      const row = repos.addClaim({ experience_id: experienceId, text: c.text, attribution: c.attribution, result_metric: c.result_metric, status: 'pending', created_from: 'repo' })
      claims.push(row)
      for (const ev of c.evidence) evidence.push(repos.addEvidence({ claim_id: row.id, kind: ev.kind, locator: ev.locator, excerpt: ev.excerpt ?? (c.needs_confirmation.length ? `待确认：${c.needs_confirmation.join('；')}` : null), strength: ev.strength }))
    }
  })
  return { claims, evidence }
}
