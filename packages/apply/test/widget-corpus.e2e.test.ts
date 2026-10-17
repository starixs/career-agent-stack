/**
 * 控件语料库（真实无头 Chrome，本地 HTTP 服务，不碰任何真实网站）：
 * 每种组件形态至少一个"能填对"和一个"做不到就留空"的用例，直接调 fillAndVerify / checkUploadEcho，
 * 断言以页面数据模型（window.__model）和用户可见显示值为准。语料页见 fixtures/corpus/*.html 头注释。
 *
 *   组件                     | 能填对                                   | 做不到就留空
 *   MTD select（真机结构）    | 学历（label 节点读回）、学校（远程搜索）  | 远程搜索搜不到同名学校
 *   antd Select              | 学历（不可搜索、不打字）、城市（showSearch）| 选项里没有 / showSearch 搜不到
 *   element-ui el-select     | 学历（readonly）、院校（filterable+remote）| remote 搜不到；可编辑但打字没反应 → 学成"不可搜索"
 *   自研 div 下拉            | 最高学历（随机类名浮层，MutationObserver） | 选项里没有；语义兜底模型 give_up
 *   内联展开（启发式认不出）  | 语义兜底层一步步点选                      | （同上 give_up）
 *   原生 select              | 性别                                     | 选项里没有
 *   antd DatePicker          | 直接输入、只读走面板                      | 超出可选年份
 *   element DatePicker       | 换写法输入（yyyy/MM，记进控件记忆）、面板  | 月份全禁用
 *   上传                     | 原名 / 改名 / el-upload 列表              | 没有任何回显
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { FakeLLM, type LlmRequest } from '@career/core'
import { chromium, type Browser, type Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures')
const DIST = join(here, '..', 'dist', 'index.js')

type Engine = typeof import('../src/index.js')
let engine: Engine | null = null
let browser: Browser | null = null
let server: Server
let base = ''
const work = mkdtempSync(join(tmpdir(), 'career-corpus-'))
const resume = join(work, '张三-简历.pdf')
writeFileSync(resume, '%PDF-1.4\n% fake resume for corpus\n')

beforeAll(async () => {
  try { engine = await import(DIST) as Engine } catch { engine = null }
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]).replace(/^\/+/, '')
    const file = join(FIXTURES, path)
    if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }) } catch { browser = null }
}, 60_000)
afterAll(async () => { await browser?.close(); await new Promise<void>(r => server.close(() => r())) })

const memStore = () => { const m = new Map<string, unknown>(); return { kvGet: <T,>(k: string) => m.get(k) as T | undefined, kvSet: (k: string, v: unknown) => { m.set(k, v) }, m } }

async function open(path: string): Promise<Page> {
  const page = await (await browser!.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(`${base}/${path}`)
  return page
}
type Extra = Partial<import('../src/fill.js').FillDeps>
async function fill(page: Page, label: string, value: string, extra: Extra = {}, nth = 0) {
  const e = engine!
  const P = e.fromPlaywright(page)
  const fields = await e.extractFields(P)
  const f = fields.filter(x => x.label === label)[nth]
  expect(f, `找不到字段「${label}」：${fields.map(x => x.label).join(' / ')}`).toBeTruthy()
  const att = await e.fillAndVerify({ page: P, pause: [0, 0], humanTyping: true, sleep: async () => {}, watchdogMs: 25_000, ...extra }, f!, value)
  const state = await page.evaluate(() => ({ model: (window as unknown as { __model: Record<string, string> }).__model, typed: (window as unknown as { __typed?: Record<string, string> }).__typed ?? {} }))
  const display = (await P.evaluate(e.readDisplayScript, { selector: f!.selector })).display
  return { att, display, f: f!, ...state }
}
const left = (att: { verified: boolean; rollback?: string }) => { expect(att.verified).toBe(false); expect(att.rollback).not.toBe('failed') }

describe('控件语料库（真实 Chrome）', () => {
  it('MTD select：label 节点读回、远程搜索选中；搜不到同名学校留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    let page = await open('meituan/form.html')
    let r = await fill(page, '学历', '硕士研究生')
    expect(r.att).toMatchObject({ verified: true, display: '硕士研究生' })
    expect(r.model.degree0).toBe('硕士研究生')
    r = await fill(page, '学校名称', '清华大学')
    expect(r.att).toMatchObject({ verified: true, strategy: 'search-click', display: '清华大学' })
    page = await open('meituan/form.html?remote=miss')
    r = await fill(page, '学校名称', '清华大学')
    left(r.att)
    expect(r.att.code).toBe('no_matching_option')
    expect(r.model.school0).toBeUndefined()
    expect(r.display).toBe('')
  }, 90_000)

  it('antd Select：不可搜索不打字、showSearch 搜索选中；选项里没有 / 搜不到留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await open('corpus/antd-select.html')
    let r = await fill(page, '学历', '硕士')
    expect(r.att).toMatchObject({ verified: true, display: '硕士研究生' })
    expect(r.model.degree).toBe('硕士研究生')
    expect(r.typed.degree).toBeUndefined()
    r = await fill(page, '期望城市', '杭州')
    expect(r.att).toMatchObject({ verified: true, display: '杭州' })
    r = await fill(page, '政治面貌', '民主党派')
    left(r.att)
    expect(r.att.code).toBe('no_matching_option')
    expect(r.typed.politics).toBeUndefined() // readonly：一个字都不打
    expect(r.model.politics).toBeUndefined()
    const page2 = await open('corpus/antd-select.html')
    r = await fill(page2, '期望城市', '拉萨')
    left(r.att)
    expect(r.model.city).toBeUndefined()
    expect(r.display).toBe('')
  }, 90_000)

  it('element el-select：readonly 选中、remote 搜索选中；remote 搜不到留空；可编辑但打字没反应 → 学成不可搜索', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await open('corpus/element-select.html')
    let r = await fill(page, '学历', '本科')
    expect(r.att).toMatchObject({ verified: true, display: '本科' })
    r = await fill(page, '毕业院校', '西京大学')
    expect(r.att).toMatchObject({ verified: true, strategy: 'search-click', display: '西京大学' })
    expect(r.model.school).toBe('西京大学')
    const page2 = await open('corpus/element-select.html')
    r = await fill(page2, '毕业院校', '北方大学')
    left(r.att)
    expect(r.model.school).toBeUndefined()
    expect(r.display).toBe('')
    // 行为探测：民族框没有 readonly，打两个字候选没变化 → 清空、按不可搜索处理，并记进控件记忆
    const store = memStore()
    const events: string[] = []
    const widgetMemory = new engine.WidgetMemory(store).bind('127.0.0.1', ev => events.push(`${ev.kind}:${ev.detail}`))
    r = await fill(page2, '民族', '藏族', { widgetMemory })
    left(r.att)
    expect(r.att.code).toBe('no_matching_option')
    expect(r.display).toBe('')
    const map = store.m.get('apply:widget_map:127.0.0.1') as Record<string, { searchable?: boolean }>
    expect(Object.values(map).some(k => k.searchable === false)).toBe(true)
    // 同站同类控件：记忆说不可搜索 → 一个字都不打
    r = await fill(page2, '籍贯', '江苏', { widgetMemory })
    left(r.att)
    expect(r.typed.hometown).toBeUndefined()
    expect(events.some(x => x.startsWith('used:'))).toBe(true)
  }, 90_000)

  it('自研 div 下拉（随机类名浮层）与原生 select：能选的选中，选项里没有的留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await open('corpus/custom-div.html')
    let r = await fill(page, '最高学历', '硕士')
    expect(r.att).toMatchObject({ verified: true, display: '硕士研究生' })
    expect(r.model.degree).toBe('硕士研究生')
    r = await fill(page, '外语语种', '法语')
    left(r.att)
    expect(r.model.lang).toBeUndefined()
    expect(r.display).toBe('')
    r = await fill(page, '性别', '男')
    expect(r.att).toMatchObject({ verified: true, display: '男' })
    expect(r.model.gender).toBe('男')
    const page2 = await open('corpus/custom-div.html')
    r = await fill(page2, '性别', '其他')
    left(r.att)
    expect(r.model.gender).toBeUndefined()
  }, 90_000)

  it('语义兜底层：启发式认不出的内联列表，模型在受限动作集里点选并核验；模型放弃 / 不可用就留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const respond = (target: string) => (req: LlmRequest) => {
      const lines = req.messages[0].content.split('\n')
      const hit = lines.find(l => new RegExp(`^r\\d+ <[^>]*> ${target}$`).test(l))
      if (hit) return JSON.stringify({ action: 'click', ref: hit.split(' ')[0] })
      const trig = lines.find(l => /role=combobox/.test(l))
      return JSON.stringify(trig ? { action: 'click', ref: trig.split(' ')[0] } : { action: 'give_up' })
    }
    let page = await open('corpus/custom-div.html')
    const llm = new FakeLLM(Array.from({ length: 6 }, () => respond('3-5年')))
    let r = await fill(page, '工作年限', '3-5年', { llm })
    expect(r.att).toMatchObject({ verified: true, strategy: 'semantic', display: '3-5年' })
    expect(r.model.years).toBe('3-5年')
    // 模型只敢点相近项 / 放弃 → 留空
    page = await open('corpus/custom-div.html')
    r = await fill(page, '工作年限', '5-10年', { llm: new FakeLLM(Array.from({ length: 6 }, () => () => JSON.stringify({ action: 'give_up' }))) })
    left(r.att)
    expect(r.model.years).toBeUndefined()
    // 没有模型：直接留空
    page = await open('corpus/custom-div.html')
    r = await fill(page, '工作年限', '3-5年')
    left(r.att)
    expect(r.att.code).toBe('options_not_found')
  }, 90_000)

  it('antd DatePicker：直接输入、只读走面板；超出可选年份留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    let page = await open('corpus/antd-datepicker.html')
    let r = await fill(page, '入学时间', '2024-09')
    expect(r.att).toMatchObject({ verified: true, strategy: 'date-typed' })
    expect(r.model.start).toBe('2024-09')
    page = await open('corpus/antd-datepicker.html?readonly=1')
    r = await fill(page, '毕业时间', '2027-06')
    expect(r.att).toMatchObject({ verified: true, strategy: 'date-panel' })
    expect(r.model.grad).toBe('2027-06')
    page = await open('corpus/antd-datepicker.html?max=2026')
    r = await fill(page, '毕业时间', '2027-06')
    left(r.att)
    expect(r.model.grad).toBeUndefined()
    expect(r.display).toBe('')
  }, 90_000)

  it('element DatePicker：换写法输入并记进控件记忆、下一格直接用；只读走面板；月份全禁用留空', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const store = memStore()
    const events: string[] = []
    const widgetMemory = new engine.WidgetMemory(store).bind('127.0.0.1', ev => events.push(`${ev.kind}:${ev.detail}`))
    let page = await open('corpus/element-datepicker.html')
    let r = await fill(page, '入学年月', '2024-09', { widgetMemory })
    expect(r.att).toMatchObject({ verified: true, strategy: 'date-typed', display: '2024/09' })
    expect(r.model.start).toBe('2024-09')
    const map = store.m.get('apply:widget_map:127.0.0.1') as Record<string, { dateFormat?: string; dateStrategy?: string }>
    expect(Object.values(map)).toEqual([expect.objectContaining({ kind: 'date', dateStrategy: 'typed', dateFormat: 'YYYY/MM' })])
    r = await fill(page, '毕业年月', '2027-06', { widgetMemory })
    expect(r.att).toMatchObject({ verified: true, display: '2027/06' })
    expect(events.some(x => x.startsWith('used:') && x.includes('YYYY/MM'))).toBe(true)
    page = await open('corpus/element-datepicker.html?readonly=1')
    r = await fill(page, '毕业年月', '2027-06')
    expect(r.att).toMatchObject({ verified: true, strategy: 'date-panel' })
    expect(r.model.grad).toBe('2027-06')
    page = await open('corpus/element-datepicker.html?lock=1')
    r = await fill(page, '毕业年月', '2027-06')
    left(r.att)
    expect(r.model.grad).toBeUndefined()
  }, 120_000)

  for (const [mode, echoed] of [['original', true], ['renamed', true], ['list', true], ['none', false]] as const) {
    it(`上传回显：${mode} → ${echoed ? '认出回显' : '不报已回显'}`, async ({ skip }) => {
      if (!browser || !engine) return skip()
      const e = engine
      const page = await open(`corpus/upload.html?mode=${mode}`)
      const P = e.fromPlaywright(page)
      const f = (await e.extractFields(P)).find(x => x.isFile)!
      const before = await P.evaluate(e.uploadAreaScript, { selector: f.selector })
      const beforeText = (await P.evaluate(e.pageSignalsScript)).text
      await P.setInputFiles(f.selector, resume)
      const check = await e.checkUploadEcho(P, f, resume, before, beforeText)
      expect(check.echoed, check.evidence).toBe(echoed)
    }, 30_000)
  }
})
