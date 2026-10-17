/**
 * 美团式网申复现页端到端回归（真实无头 Chrome，本地 HTTP 服务，不碰任何真实网站）：
 * 从岗位详情页开始 → 点「立即申请」入口 → 上传简历 → 处理"是否解析附件"弹窗 → 下拉 / 年月 / 文本全部填对并核验
 * → 停在「投递」前、绝不点击。复现页控件按真机 MTD DOM 抽取（见 fixtures/meituan/form.html 头注释）。
 * 另有"做不到就留空"用例：学历下拉永远选不中、远程搜索搜不到同名学校 → needs_user 而不是 ok。
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
    typed: (window as unknown as { __typedInto: Record<string, string> }).__typedInto,
    labels: Array.from(document.querySelectorAll('.mtd-select-filter-label')).map(n => n.textContent ?? ''),
    selectInputs: Array.from(document.querySelectorAll('.mtd-select-filter-input input')).map(i => (i as HTMLInputElement).value),
    lab: (document.getElementById('lab-input') as HTMLInputElement).value,
    overlay: !!document.querySelector('[data-career-overlay]'),
    contactEmail: (document.getElementById('contact-email') as HTMLInputElement).value,
    // 页面上所有文本框的值（复核把值写错格子时，邮箱 / 手机号会出现在别的格子里）
    textValues: Array.from(document.querySelectorAll('input[type=text]')).map(i => ({ id: i.id, ph: i.getAttribute('placeholder') ?? '', v: (i as HTMLInputElement).value })),
  }))
  return { result, state, progress, logs }
}

describe('美团式复现页（真实 Chrome）', () => {
  it('详情页 → 入口 → 上传 → 弹窗选"仅上传" → 下拉 / 年月 / 文本全部核验通过 → 停在「投递」前', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    const { result: r, state, progress } = await run(page, `${base}/detail.html`, 'act_repro_ok')
    // 加一行教育经历会让后面字段的编号顺移：复核必须认准同一个格子，不能把值写进别的格子
    expect(state.contactEmail).toBe('zhangsan@example.com')
    expect(state.textValues.filter(t => t.v.includes('@')).map(t => t.id)).toEqual(['', 'contact-email'].filter(id => state.textValues.some(t => t.id === id && t.v.includes('@'))))
    expect(state.textValues.filter(t => t.v.includes('@')).length).toBe(2) // 基本信息邮箱 + 联系邮箱，别处不该有

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
    expect(state.model).toMatchObject({
      gender: '男', area: '86',
      school0: '清华大学', major0: '电子信息', degree0: '硕士研究生', start0: '2024-09', grad0: '2027-06',
      school1: '西京大学', major1: '计算机科学与技术', degree1: '大学本科', start1: '2020-09', grad1: '2024-06',
    })
    for (const f of r.filled) expect(f.verified, `${f.label} 应读回核验通过`).toBe(true)
    const byLabel = (l: string) => r.filled.filter(f => f.label === l).map(f => f.display)
    // 1. MTD 下拉：显示值从 .mtd-select-filter-label 读回
    expect(byLabel('学历')).toEqual(['硕士研究生', '大学本科'])
    // 3. 远程搜索下拉：键入关键字 → 等结果 → 点选；搜出来的「清华大学深圳国际研究生院」「西京大学附属学院」不会被当成同一所
    expect(byLabel('学校名称')).toEqual(['清华大学', '西京大学'])
    // 2. 联动禁用的专业名称：选完学校解锁后再填；不再把别的下拉里的「请输入工作城市」当选项
    expect(byLabel('专业名称')).toEqual(['电子信息', '计算机科学与技术'])
    // 2. 手机号码：账号绑定、整组禁用 → 认出页面原有值一致，不去点区号下拉
    expect(r.filled.find(f => f.label === '手机号码')).toMatchObject({ verified: true, strategy: 'already' })
    expect(r.fields.find(f => f.label === '国际区号')).toBeTruthy()
    expect(r.fields.some(f => f.code === 'no_matching_option' || f.code === 'field_disabled')).toBe(false)
    // 4. MTD 日期：面板只点开一次，按年 → 月选中
    expect(byLabel('毕业时间')).toEqual(['2027-06', '2024-06'])
    expect(byLabel('在校时间')).toEqual(['2024-09', '2020-09'])
    expect(byLabel('姓名')).toEqual(['张三'])
    expect(r.mismatches).toEqual([])
    expect(r.pages[0].sections?.[0]).toMatchObject({ key: 'education', added: 1, rowsAfter: 2 })
    // 不可搜索的性别下拉（readonly）没被打过字；可搜索的只打过学校关键字
    expect(state.typed.gender).toBeUndefined()
    expect(Object.keys(state.typed).every(k => k.startsWith('school'))).toBe(true)
    expect(state.selectInputs.every(v => v === '')).toBe(true)

    // 标签：没有字段被认成吸顶栏的"LongCat人才招聘"；画在 canvas 里的那格标签不确定、留空
    expect(r.fields.some(f => /LongCat/.test(f.label))).toBe(false)
    expect(state.lab).toBe('')
    const unlabeled = r.fields.filter(f => f.labelUncertain)
    expect(unlabeled.length).toBeGreaterThanOrEqual(1)
    expect(r.fields.filter(f => f.label === '学院名称').length).toBe(2) // ::before 伪元素标签也认得出

    // 必填：MTD 的 class / ::before 星号 / 星号节点 / aria-required 都认出来，requiredTotal 可信；选填空值单独标
    const req = (l: string) => r.fields.find(f => f.label === l)?.required
    expect([req('上传简历附件'), req('姓名'), req('手机号码'), req('邮箱'), req('学历'), req('毕业时间')]).toEqual([true, true, true, true, true, true])
    expect(req('导师')).toBe(false)
    expect(r.review).toMatchObject({ requiredTrusted: true })
    expect(r.review!.requiredTotal).toBeGreaterThanOrEqual(10)
    expect(r.review!.requiredFilled).toBe(r.review!.requiredTotal)
    expect(r.review!.rows.find(x => x.label === '导师')?.status).toBe('empty_optional')
    expect(r.review!.verified).toBe(true)

    // 没有整页被选中；高亮框动作后移除
    expect(state.maxSelection).toBeLessThan(20)
    expect(state.selectionNow).toBe(0)
    expect(state.overlay).toBe(false)

    // 进度是人话，不带 Playwright 报错 / 内部日志
    expect(progress).toEqual(expect.arrayContaining(['点击「立即申请」进入申请表', '弹窗：已选「否，仅做附件上传」', '正在填「学历」', '「学历」选择了「硕士研究生」', '「学校名称」选择了「清华大学」']))
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
    // 运行记录文件名保留中文字段名
    expect(readdirSync(dir).some(f => /^shot-\d+-before-学历\.jpg$/.test(f))).toBe(true)
    // 5. 上传：异步回显、文件名被改成全角横线也认得
    expect(trace.some(t => t.stage === 'upload' && t.result === 'ok')).toBe(true)
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
    expect(state.model).toMatchObject({ gender: '男', grad0: '2027-06', school0: '清华大学' })
    expect(state.labels.filter(t => t === '请选择').length).toBeGreaterThanOrEqual(2) // 学历两格仍显示占位
    const summary = JSON.parse(readFileSync(join(work, 'runs', 'act_repro_broken', 'summary.json'), 'utf8'))
    expect(summary.codes.option_not_selected).toBe(2)
  }, 120_000)

  it('远程搜索下拉搜不到同名学校 → 留空 needs_user，不选近似项、不留搜索词', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    const { result: r, state } = await run(page, `${base}/form.html?remote=miss`, 'act_repro_remote_miss')
    expect(r.status).toBe('stopped_before_submit')
    expect(state.submitted).toBe(false)
    const school = r.fields.filter(f => f.label === '学校名称')
    expect(school.length).toBe(2)
    for (const s of school) expect(s).toMatchObject({ status: 'needs_user', verified: false, code: 'no_matching_option' })
    expect(r.filled.some(f => f.label === '学校名称')).toBe(false)
    expect(state.model.school0).toBeUndefined()
    expect(state.model.school1).toBeUndefined()
    // 搜索词不留在框里冒充值；学校没选上，联动的专业仍是灰的 → 不碰、留给用户
    expect(state.selectInputs.every(v => v === '')).toBe(true)
    expect(r.fields.filter(f => f.label === '专业名称').every(f => f.status === 'needs_user' && !f.verified)).toBe(true)
    // 打过字的只有可搜索的学校框
    expect(Object.keys(state.typed).every(k => k.startsWith('school'))).toBe(true)
    // 其他字段照常
    expect(state.model).toMatchObject({ gender: '男', degree0: '硕士研究生', grad0: '2027-06' })
  }, 120_000)
})
