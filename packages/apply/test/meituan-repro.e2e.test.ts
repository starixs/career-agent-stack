/**
 * 美团式网申复现页端到端回归（真实无头 Chrome，本地 HTTP 服务，不碰任何真实网站）：
 * 从岗位详情页开始 → 点「立即申请」入口 → 上传简历 → 处理"是否解析附件"弹窗 → 下拉 / 年月 / 文本全部填对并核验
 * → 停在「投递」前、绝不点击。另有"做不到就留空"用例：学历下拉永远选不中 → needs_user 而不是 ok。
 *
 * 引擎从 dist 加载（与 shell 一致；也避开测试转译给页内脚本注入的辅助函数）。跑之前先 `npm run build`。
 * 本机没有 Chrome 或 dist 未构建时跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { FakeLLM } from '@career/core'
import { chromium, type Browser, type Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures', 'meituan')
const DIST = join(here, '..', 'dist', 'index.js')

type Engine = typeof import('../src/index.js')
let engine: Engine | null = null
let browser: Browser | null = null
let server: Server
let base = ''
const work = mkdtempSync(join(tmpdir(), 'career-e2e-'))
const resume = join(work, '张三-简历.pdf')
writeFileSync(resume, '%PDF-1.4\n% fake resume for repro\n')

beforeAll(async () => {
  try { engine = await import(DIST) as Engine } catch { engine = null }
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'detail.html'
    const file = join(FIXTURES, path)
    if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }) } catch { browser = null }
}, 60_000)
afterAll(async () => { await browser?.close(); await new Promise<void>(r => server.close(() => r())) })

const profile = {
  basics: { name: '张三', email: 'zhangsan@example.com', phone: '13800000000', gender: '男', school: '清华大学', major: '电子信息', degree: '硕士', graduation: '2027-06' },
  experiences: [],
  education: [
    { school: '清华大学', major: '电子信息', degree: '硕士', start: '2024-09', end: '2027-06' },
    { school: '西京大学', major: '计算机科学与技术', degree: '本科', start: '2020-09', end: '2024-06' },
  ],
  answerBank: [],
  resumePath: resume,
}

async function run(page: Page, url: string, runId: string) {
  await page.goto(url)
  const progress: string[] = []
  const logs: string[] = []
  const e = engine!
  const result = await e.driveApplication(e.fromPlaywright(page), new FakeLLM([]), profile, {
    pause: [0, 0], settleMs: 250, humanTyping: true, sleep: async () => {},
    onProgress: p => progress.push(p.message), log: m => logs.push(m),
    telemetry: { dir: join(work, 'runs'), runId },
  })
  const state = await page.evaluate(() => ({
    model: (window as unknown as { __model: Record<string, string> }).__model,
    submitted: (window as unknown as { __submitted: boolean }).__submitted,
    parsed: (window as unknown as { __parsedResume: boolean }).__parsedResume,
    maxSelection: (window as unknown as { __maxSelection: number }).__maxSelection,
    selectionNow: (window.getSelection()?.toString() ?? '').length,
    inputs: Array.from(document.querySelectorAll('input.mtd-input')).map(i => (i as HTMLInputElement).value),
    lab: (document.getElementById('lab-input') as HTMLInputElement).value,
    overlay: !!document.querySelector('[data-career-overlay]'),
  }))
  return { result, state, progress, logs }
}

describe('美团式复现页（真实 Chrome）', () => {
  it('详情页 → 入口 → 上传 → 弹窗选"仅上传" → 下拉 / 年月 / 文本全部核验通过 → 停在「投递」前', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    const { result: r, state, progress } = await run(page, `${base}/detail.html`, 'act_repro_ok')

    // 入口与停点：点了「立即申请」，没点「投递」
    expect(r.entryClicked).toBe('立即申请')
    expect(page.url()).toContain('/form.html')
    expect(r.status).toBe('stopped_before_submit')
    expect(r.submitButton).toBe('投递')
    expect(state.submitted).toBe(false)

    // 弹窗：选了"否，仅做附件上传"，没有让站点解析覆盖
    expect(r.blockers).toEqual([expect.objectContaining({ choice: '否，仅做附件上传', by: 'rule', resolved: true })])
    expect(state.parsed).toBe(false)
    expect(r.uploads[0]).toMatchObject({ echoed: true })

    // 数据模型（不是 input 的展示值）里是对的：没有假成功
    expect(state.model).toMatchObject({ gender: '男', degree0: '硕士研究生', grad0: '2027-06', degree1: '本科', grad1: '2024-06' })
    for (const f of r.filled) expect(f.verified, `${f.label} 应读回核验通过`).toBe(true)
    const byLabel = (l: string) => r.filled.filter(f => f.label === l).map(f => f.display)
    expect(byLabel('学历')).toEqual(['硕士研究生', '本科'])
    expect(byLabel('学校名称')).toEqual(['清华大学', '西京大学'])
    expect(byLabel('专业名称')).toEqual(['电子信息', '计算机科学与技术'])
    expect(byLabel('姓名')).toEqual(['张三'])
    expect(r.mismatches).toEqual([])
    expect(r.pages[0].sections?.[0]).toMatchObject({ key: 'education', added: 1, rowsAfter: 2 })

    // 标签：没有字段被认成吸顶栏的"LongCat人才招聘"；画在 canvas 里的那格标签不确定、留空
    expect(r.fields.some(f => /LongCat/.test(f.label))).toBe(false)
    expect(state.lab).toBe('')
    const unlabeled = r.fields.filter(f => f.labelUncertain)
    expect(unlabeled.length).toBeGreaterThanOrEqual(1)
    expect(r.fields.filter(f => f.label === '学院名称').length).toBe(2) // ::before 伪元素标签也认得出

    // 必填：MTD 的 class / ::before 星号 / 星号节点 / aria-required 都认出来，requiredTotal 可信；选填空值单独标
    const req = (l: string) => r.fields.find(f => f.label === l)?.required
    expect([req('上传简历附件'), req('姓名'), req('手机号'), req('邮箱'), req('学历'), req('毕业时间')]).toEqual([true, true, true, true, true, true])
    expect(req('导师')).toBe(false)
    expect(r.review).toMatchObject({ requiredTrusted: true })
    expect(r.review!.requiredTotal).toBeGreaterThanOrEqual(8)
    expect(r.review!.requiredFilled).toBe(r.review!.requiredTotal)
    expect(r.review!.rows.find(x => x.label === '导师')?.status).toBe('empty_optional')
    expect(r.review!.verified).toBe(true)

    // 没有整页被选中；高亮框动作后移除
    expect(state.maxSelection).toBeLessThan(20)
    expect(state.selectionNow).toBe(0)
    expect(state.overlay).toBe(false)

    // 进度是人话，不带 Playwright 报错 / 内部日志
    expect(progress).toEqual(expect.arrayContaining(['点击「立即申请」进入申请表', '弹窗：已选「否，仅做附件上传」', '正在填「学历」', '「学历」选择了「硕士研究生」']))
    expect(progress.join('\n')).not.toMatch(/locator|Timeout|intercepts|native-input|actuator/i)

    // 遥测
    const dir = join(work, 'runs', 'act_repro_ok')
    expect(r.telemetry?.dir).toBe(dir)
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ host: '127.0.0.1', status: 'stopped_before_submit', entryClicked: '立即申请', requiredTrusted: true })
    expect(summary.libraries).toContain('mtd')
    expect(summary.fields.verified).toBeGreaterThanOrEqual(10)
    expect(summary.blockers[0]).toMatchObject({ choice: '否，仅做附件上传', resolved: true })
    const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(trace.some(t => t.stage === 'field' && t.label === '毕业时间' && t.result === 'ok' && /date-panel/.test(t.strategy))).toBe(true)
    expect(readFileSync(join(dir, 'trace.jsonl'), 'utf8')).not.toContain('13800000000')
    expect(readdirSync(dir).filter(f => f.endsWith('.jpg')).length).toBeGreaterThan(0)
  }, 120_000)

  it('做不到就留空：学历下拉永远选不中 → needs_user（附原因码），不是 ok；页面上也没留下错值', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    const { result: r, state } = await run(page, `${base}/form.html?broken=1`, 'act_repro_broken')
    expect(r.status).toBe('stopped_before_submit')
    expect(state.submitted).toBe(false)
    const degree = r.fields.filter(f => f.label === '学历')
    expect(degree.length).toBe(2)
    for (const d of degree) {
      expect(d).toMatchObject({ status: 'needs_user', verified: false, code: 'option_not_selected' })
      expect(d.reason).toBeTruthy()
    }
    expect(r.filled.some(f => f.label === '学历')).toBe(false)
    expect(state.model.degree0).toBeUndefined()
    expect(state.model.degree1).toBeUndefined()
    const rows = r.review!.rows.filter(x => x.label === '学历')
    expect(rows.every(x => x.status === 'needs_user' && x.reasonCode === 'option_not_selected')).toBe(true)
    expect(r.review!.attention).toBeGreaterThanOrEqual(2)
    // 其他字段照常核验通过
    expect(state.model).toMatchObject({ gender: '男', grad0: '2027-06' })
    const summary = JSON.parse(readFileSync(join(work, 'runs', 'act_repro_broken', 'summary.json'), 'utf8'))
    expect(summary.codes.option_not_selected).toBe(2)
  }, 120_000)
})
