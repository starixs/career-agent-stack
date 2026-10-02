import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeLLM } from '@career/core'
import { collectRepoStats, detectTechStack, mineRepo, importMineResult, buildMinePrompt } from '../src/index.js'
import { memRepos } from './helpers.js'

let repo: string
const hashes: string[] = [] // 按提交顺序：0 alice init, 1 alice cache, 2 bob fix, 3 alice util

function git(args: string[], author?: { name: string; email: string }) {
  const cfg = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : []
  return execFileSync('git', [...cfg, '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repo } }).trim()
}
const alice = { name: 'Alice Zhang', email: 'alice@example.com' }
const bob = { name: 'Bob Li', email: 'bob@example.com' }

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'miner-'))
  git(['init', '-q'])
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo-api', description: '示例 API 服务', dependencies: { express: '^4', ioredis: '^5' }, devDependencies: { vitest: '^3' } }))
  writeFileSync(join(repo, 'README.md'), '# demo-api\n\n一个基于 Express 的示例服务。\n')
  writeFileSync(join(repo, 'src/server.ts'), 'import express from "express"\nconst app = express()\napp.listen(3000)\n')
  git(['add', '.']); git(['commit', '-q', '-m', 'init: express server', '--date', '2025-01-10T10:00:00+08:00'], alice)
  writeFileSync(join(repo, 'src/cache.ts'), 'import Redis from "ioredis"\nexport const redis = new Redis()\nexport async function cached(k: string) { return redis.get(k) }\n')
  git(['add', '.']); git(['commit', '-q', '-m', 'feat: add redis cache layer, cut p95 latency by 40%', '--date', '2025-02-01T10:00:00+08:00'], alice)
  writeFileSync(join(repo, 'src/cache.ts'), 'import Redis from "ioredis"\nexport const redis = new Redis()\nexport async function cached(k: string) { return redis.get(k) }\nexport const TTL = 60\n')
  git(['add', '.']); git(['commit', '-q', '-m', 'fix: cache ttl', '--date', '2025-02-15T10:00:00+08:00'], bob)
  writeFileSync(join(repo, 'src/util.ts'), 'export const sum = (a: number, b: number) => a + b\n')
  git(['add', '.']); git(['commit', '-q', '-m', 'feat: util helpers', '--date', '2025-03-01T10:00:00+08:00'], alice)
  hashes.push(...git(['log', '--reverse', '--format=%H']).split('\n'))
})

describe('collectRepoStats', () => {
  it('提交数/占比/改动行数/活跃文件/时间跨度/blame 抽样', async () => {
    const s = await collectRepoStats(repo, { author: 'alice@example.com' })
    expect(s.totalCommits).toBe(4)
    expect(s.authorCommits).toBe(3)
    expect(s.authorShare).toBe(0.75)
    expect(s.contributorCount).toBe(2)
    expect(s.contributors.map(c => c.name)).toEqual(['Alice Zhang', 'Bob Li'])
    expect(s.selfAllowed).toBe(true)
    expect(s.firstDate).toBe('2025-01-10'); expect(s.lastDate).toBe('2025-03-01')
    expect(s.authorFirstDate).toBe('2025-01-10'); expect(s.authorLastDate).toBe('2025-03-01')
    expect(s.authorAdded).toBeGreaterThan(0); expect(s.totalAdded).toBeGreaterThan(s.authorAdded)
    const cache = s.activeFiles.find(f => f.path === 'src/cache.ts')!
    expect(cache).toMatchObject({ commits: 2, authorCommits: 1 })
    expect(s.activeFiles.find(f => f.path === 'src/server.ts')?.authorCommits).toBe(1)
    const blameServer = s.blameSamples.find(b => b.path === 'src/server.ts')!
    expect(blameServer.share).toBe(1)
    const blameCache = s.blameSamples.find(b => b.path === 'src/cache.ts')!
    expect(blameCache.authorLines).toBe(3); expect(blameCache.totalLines).toBe(4)
    expect(s.authorCommitList.map(c => c.hash)).toEqual([hashes[3], hashes[1], hashes[0]])
  })
  it('bob 占比 25% → 不允许 self 强证据；RegExp 匹配作者；未指定作者时按仓库 user 推断', async () => {
    const b = await collectRepoStats(repo, { author: /bob@/ })
    expect(b.authorCommits).toBe(1); expect(b.authorShare).toBe(0.25); expect(b.selfAllowed).toBe(false)
    const auto = await collectRepoStats(repo)
    expect(auto.authorCommits).toBe(3) // 无 git config user → 提交最多的 alice
  })
  it('非 git 目录报错', async () => {
    await expect(collectRepoStats(mkdtempSync(join(tmpdir(), 'nogit-')), {})).rejects.toThrow('不是 git 仓库')
  })
})

describe('detectTechStack', () => {
  it('从 package.json / README 识别语言、依赖、框架', async () => {
    const t = await detectTechStack(repo)
    expect(t.projectName).toBe('demo-api'); expect(t.description).toBe('示例 API 服务')
    expect(t.languages).toEqual({ TypeScript: 3 })
    expect(t.frameworks).toEqual(expect.arrayContaining(['Express', 'Redis', '单元测试']))
    expect(t.readmeExcerpt).toContain('Express')
  })
})

describe('mineRepo 规则校验', () => {
  it('提示词里强调"用了 X ≠ 我做了 X"，并只列出本人 hash', async () => {
    const s = await collectRepoStats(repo, { author: alice.email })
    const t = await detectTechStack(repo)
    const { system, user } = buildMinePrompt(s, t, '招聘 Node.js 后端')
    expect(system).toContain('"项目用了 X" ≠ "我做了 X"')
    expect(user).toContain(hashes[1]); expect(user).not.toContain(hashes[2])
    expect(user).toContain('招聘 Node.js 后端')
  })

  it('alice（75%）：保留可核实证据，丢弃非本人 hash / 不存在路径 / 无证据的主张，量化数据按可证性处理', async () => {
    const llm = new FakeLLM([JSON.stringify({
      claims: [
        { text: '引入 Redis 缓存层，降低接口 p95 延迟', attribution: 'self', result_metric: 'p95 延迟降低 40%', evidence: [{ kind: 'commit', locator: hashes[1], strength: 'strong', excerpt: 'feat: add redis cache layer, cut p95 latency by 40%' }, { kind: 'code', locator: `src/cache.ts:3@${hashes[1]}`, strength: 'strong' }] },
        { text: '修复缓存 TTL', attribution: 'self', result_metric: null, evidence: [{ kind: 'commit', locator: hashes[2], strength: 'strong' }] },
        { text: '实现 GraphQL 网关', attribution: 'team', result_metric: null, evidence: [{ kind: 'code', locator: 'src/graphql.ts:1', strength: 'mid' }] },
        { text: '独立搭建 Express 服务骨架', attribution: 'self', result_metric: '支撑 QPS 5000', evidence: [{ kind: 'commit', locator: hashes[0].slice(0, 7), strength: 'mid' }, { kind: 'code', locator: 'src/server.ts', strength: 'weak' }] },
        { text: '没有证据的主张', attribution: 'unknown', result_metric: null, evidence: [] },
      ],
      notes: ['模型备注'],
    })])
    const r = await mineRepo(repo, { author: alice.email, llm })
    expect(llm.calls).toHaveLength(1); expect(llm.calls[0].json).toBe(true)
    expect(r.claims.map(c => c.text)).toEqual(['引入 Redis 缓存层，降低接口 p95 延迟', '独立搭建 Express 服务骨架'])
    expect(r.dropped.map(d => d.text)).toEqual(['修复缓存 TTL', '实现 GraphQL 网关', '没有证据的主张'])
    const c1 = r.claims[0]
    expect(c1.attribution).toBe('self'); expect(c1.result_metric).toBe('p95 延迟降低 40%')
    expect(c1.evidence).toEqual([{ kind: 'commit', locator: hashes[1], strength: 'strong', excerpt: 'feat: add redis cache layer, cut p95 latency by 40%' }, { kind: 'code', locator: `src/cache.ts:3@${hashes[1]}`, strength: 'strong', excerpt: null }])
    const c4 = r.claims[1]
    expect(c4.result_metric).toBeNull()
    expect(c4.needs_confirmation.some(n => n.includes('QPS 5000'))).toBe(true)
    expect(c4.evidence[0].locator).toBe(hashes[0]) // 短 hash 补全
    expect(c4.evidence[1].locator).toBe(`src/server.ts@${r.stats.head}`) // 无 hash 的代码定位补 HEAD
    expect(r.notes.some(n => n.includes('模型备注'))).toBe(true)
    expect(r.notes.some(n => n.includes('无法核实'))).toBe(true)
  })

  it('bob（25%，贡献者 2 人）：self 降为 team，strong 降为 mid，并要求本人确认', async () => {
    const llm = new FakeLLM(['```json\n' + JSON.stringify({ claims: [{ text: '主导缓存 TTL 修复', attribution: 'self', result_metric: null, evidence: [{ kind: 'commit', locator: hashes[2], strength: 'strong' }] }] }) + '\n```'])
    const r = await mineRepo(repo, { author: bob.email, llm })
    expect(r.stats.selfAllowed).toBe(false)
    expect(r.claims).toHaveLength(1)
    expect(r.claims[0].attribution).toBe('team')
    expect(r.claims[0].evidence[0].strength).toBe('mid')
    expect(r.claims[0].needs_confirmation.join('\n')).toMatch(/占比 25%/)
    expect(r.claims[0].needs_confirmation.join('\n')).toMatch(/个人角色/)
    expect(r.notes[0]).toMatch(/团队成果/)
  })

  it('找不到本人提交时不调模型', async () => {
    const llm = new FakeLLM([])
    const r = await mineRepo(repo, { author: 'nobody@example.com', llm })
    expect(r.claims).toEqual([]); expect(llm.calls).toHaveLength(0); expect(r.notes[0]).toContain('没有匹配')
  })

  it('模型输出不是 JSON 时报错', async () => {
    await expect(mineRepo(repo, { author: alice.email, llm: new FakeLLM(['我不知道']) })).rejects.toThrow('claims JSON')
  })
})

describe('importMineResult', () => {
  it('写入 claim/evidence，status 一律 pending，created_from=repo', () => {
    const repos = memRepos()
    const exp = repos.createExperience({ title: 'demo-api', type: 'dev' })
    const r = importMineResult(repos, exp.id, { claims: [
      { text: 'A', attribution: 'self', result_metric: '40%', evidence: [{ kind: 'commit', locator: 'abc', strength: 'strong', excerpt: 'msg' }], needs_confirmation: [] },
      { text: 'B', attribution: 'team', result_metric: null, evidence: [{ kind: 'code', locator: 'src/x.ts:1@abc', strength: 'mid' }], needs_confirmation: ['量化数据需确认'] },
    ] })
    expect(r.claims).toHaveLength(2); expect(r.evidence).toHaveLength(2)
    const tree = repos.experienceTree()[0]
    expect(tree.claims.map(c => [c.status, c.created_from, c.attribution])).toEqual([['pending', 'repo', 'self'], ['pending', 'repo', 'team']])
    expect(tree.claims[0].evidence[0]).toMatchObject({ kind: 'commit', locator: 'abc', strength: 'strong', excerpt: 'msg' })
    expect(tree.claims[1].evidence[0].excerpt).toContain('待确认')
  })
})
