/**
 * 控件语料库（真实无头 Chrome，本地 HTTP 服务，不碰任何真实网站）：
 * 每种组件形态至少一个"能填对"和一个"做不到就留空"的用例，直接调 fillAndVerify / checkUploadEcho，
 * 断言以页面数据模型（window.__model）和用户可见显示值为准。语料页见 fixtures/corpus/*.html 头注释。
 *
 *   组件                     | 能填对                                   | 做不到就留空
 *   飞书 UD Select（真机结构）| 学历、学历类型（选项包 5 层的虚拟列表）    | 选项里没有
 *   MTD select（真机结构）    | 学历（label 节点读回）、学校（远程搜索）  | 远程搜索搜不到同名学校
 *   antd Select              | 学历（不可搜索、不打字）、城市（showSearch）| 选项里没有 / showSearch 搜不到
 *   element-ui el-select     | 学历（readonly）、院校（filterable+remote）| remote 搜不到；可编辑但打字没反应 → 学成"不可搜索"
 *   自研 div 下拉            | 最高学历（随机类名浮层，MutationObserver） | 选项里没有；模型接手也 give_up
 *   内联展开（启发式认不出）  | 模型接手（field-agent）一步步点选          | （同上 give_up）
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

  it('MTD 联动下拉：点开是「无数据」先等选项加载，不打字；字面对不上按意思从列表里挑', async ({ skip }) => {
    if (!browser || !engine) return skip()
    const page = await open('meituan/form.html')
    let r = await fill(page, '外语语种', '英语')
    expect(r.att).toMatchObject({ verified: true, display: '英语' })
    const calls: LlmRequest[] = []
    const llm = new FakeLLM([(req: LlmRequest) => { calls.push(req); return JSON.stringify({ index: JSON.parse(String(req.messages[0].content)).options.findIndex((o: { text: string }) => o.text === 'CET-6') }) }])
    r = await fill(page, '外语等级', '英语六级', { llm })
    expect(r.att).toMatchObject({ verified: true, strategy: 'llm-option-click', display: 'CET-6' })
    expect(r.model.langLevel).toBe('CET-6')
    expect((await page.evaluate(() => (window as unknown as { __typedInto: Record<string, string> }).__typedInto)).langLevel).toBeUndefined()
    expect(calls).toHaveLength(1)
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
    // 行为探测：民族框没有 readonly、列表长（可能只显示了一部分），打两个字候选没变化 → 清空、按不可搜索处理，并记进控件记忆。
    // 列表里没有「藏族」：短列表不会打字，长列表才值得试搜
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
    expect(r.typed.hometown).toBeUndefined() // 记忆说不可搜索，且列表短：一个字都不打
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

  it('模型接手（field-agent）：启发式认不出的内联列表，模型点开、点选并核验；模型放弃 / 不可用就留空', async ({ skip }) => {
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
    expect(r.att).toMatchObject({ verified: true, strategy: 'agent', display: '3-5年' })
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

describe('飞书 formily 表单结构（真实 Chrome）', () => {
  it('标签认网站自己标的字段名、必填认 asterisk 星号：只读手机号后面的邮箱框不会被认成「手机号码」', async ({ skip }) => {
    if (!engine || !browser) skip()
    const page = await open('corpus/feishu-formily.html')
    const fields = await engine!.extractFields(engine!.fromPlaywright(page))
    const byLabel = Object.fromEntries(fields.map(f => [f.label, f]))
    // 弹层里的树节点勾选框不算字段；没有 name 的单选按字段项成一组，选项用自己的文字、默认选中读 aria-checked
    expect(Object.keys(byLabel)).toEqual(['邮箱', '年龄', '期望工作地点', '学校名称', '推荐方式'])
    // 学校名称：输入框里的值就是选中值，必填星号也认得出（投前过目不能报「选填，留空」）
    expect(byLabel['学校名称']).toMatchObject({ value: '华东理工大学', required: true })
    expect(byLabel['邮箱'].required).toBe(true)
    expect(byLabel['年龄'].required).toBe(true)
    expect(byLabel['期望工作地点'].required).toBe(false)
    expect(byLabel['推荐方式']).toMatchObject({ type: 'radio', options: ['无', '内推', '大使推荐'], value: '无', required: true })
    // 投递次数说明是信息横幅，不是校验错误；邮箱下面的红字才是
    const sig = await engine!.fromPlaywright(page).evaluate(engine!.pageSignalsScript)
    expect(sig.errors).toEqual(['请输入正确的邮箱'])
    await page.context().close()
  })
})

describe('Moka 申请表（真实 Chrome）', () => {
  it('哈希后缀的必填星号认得出；控件里的校验红字不当标签、不当选中值', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/moka-apply.html')
    const fields = await engine.extractFields(engine.fromPlaywright(page))
    expect(fields.map(f => f.label)).toEqual(['意向工作城市', '推荐码', '是否接受地点调剂', '姓名'])
    const by = Object.fromEntries(fields.map(f => [f.label, f]))
    expect(by['意向工作城市']).toMatchObject({ required: true, value: undefined })
    expect(by['推荐码'].required).toBe(false)
    expect(by['是否接受地点调剂']).toMatchObject({ required: true, value: '是' })
    expect(by['姓名']).toMatchObject({ required: true, value: undefined })
    await page.context().close()
  })
})

describe('头条问卷（真实 Chrome）', () => {
  it('控件嵌得深也按表单项认题目；单独一块的题号不进标签；单选组也有题目（2026-11-06 五道题都认成了 01…05）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/toutiao-survey.html')
    const fields = await engine.extractFields(engine.fromPlaywright(page))
    expect(fields.map(f => f.label)).toEqual(['你的姓名', '你的手机号', '你的在读最高学历'])
    expect(fields.every(f => f.required && !f.labelUncertain)).toBe(true)
    expect(fields[2]).toMatchObject({ type: 'radio', options: ['本科', '硕士'] })
    await page.context().close()
  })
})

describe('问卷星（真实 Chrome）', () => {
  it('整页 fieldset 不当单选组容器；选项文字在 div[for] 里；点选中、读得回', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/wjx-questionnaire.html')
    const P = engine.fromPlaywright(page)
    const fields = await engine.extractFields(P)
    const gender = fields.find(f => f.type === 'radio' && f.options?.includes('男'))
    expect(gender).toMatchObject({ label: expect.stringContaining('您的性别'), options: ['男', '女'], required: true })
    const degree = fields.find(f => f.type === 'radio' && f.options?.includes('硕士'))
    expect(degree).toMatchObject({ label: expect.stringContaining('学历'), options: ['本科', '硕士', '博士'] })
    expect(fields.filter(f => /您的姓名/.test(f.label))).toHaveLength(1)
    // select2 外壳不是第二个字段：只有原生 select 一个「政治面貌」，没有空标签的必填项
    expect(fields.filter(f => /政治面貌/.test(f.label)).map(f => f.type)).toEqual(['select'])
    expect(fields.filter(f => !f.label.trim())).toEqual([])
    const r = await fill(page, gender!.label, '男')
    expect(r.att).toMatchObject({ verified: true })
    expect(r.model.q2).toBe('男')
    await page.context().close()
  }, 90_000)
})

describe('问卷星地区浮层（真实 Chrome）', () => {
  it('select2 省 / 市：结果项真点击被遮罩挡、派发 click 又不算——在它包着的原生下拉里选上，点完成后读回（2026-11-02 斯达半导体）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const pick = (re: RegExp) => (req: LlmRequest) => {
      const hit = String(req.messages[0].content).split('\n').find(l => re.test(l))
      return JSON.stringify(hit ? { action: 'click', ref: hit.split(' ')[0] } : { action: 'give_up' })
    }
    const steps = [/^r\d+ <input[^>]*> /, /^r\d+ <span[^>]*> --请选择省份--$/, /^r\d+ <li[^>]*> 浙江$/, /^r\d+ <span[^>]*> --请选择城市--$/, /^r\d+ <li[^>]*> 杭州市$/, /^r\d+ <a[^>]*> 完成$/]
    const llm = new FakeLLM([...steps.map(pick), () => JSON.stringify({ action: 'done' })])
    const page = await open('corpus/wjx-city-popup.html')
    const r = await fill(page, '7.您的户籍所在地', '浙江-杭州市', { llm })
    expect(r.att).toMatchObject({ verified: true, strategy: 'agent' })
    expect(r.model.q7).toBe('浙江-杭州市')
    await page.context().close()
  }, 90_000)

  it('上一格没选完留下的 layui 选择浮层：收起时关掉，下一格不会点进上一格的浮层（2026-11-02 现居住地选进了户籍的浮层）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/wjx-city-popup.html')
    await page.click('#q7', { force: true })
    expect(await page.isVisible('.layui-layer')).toBe(true)
    await engine.fromPlaywright(page).evaluate(engine.closePopupScript, { selector: '#q8' })
    expect(await page.isVisible('.layui-layer')).toBe(false)
    await page.context().close()
  }, 30_000)
})

describe('锁定的格子（真实 Chrome）', () => {
  it('网站锁着、里面已有值：算填好了、记页面真值，不推给他；锁着又是空的才是灰格子（2026-11-02 美团手机号码 / 区号）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/locked-field.html')
    const ok = await fill(page, '手机号码', '15500001234')
    expect(ok.att).toMatchObject({ verified: true, strategy: 'locked-prefilled' })
    // 锁着的是网站自己的值（区号锁成 86、别的号码）：他也改不了，不算缺项，记页面上的值
    const other = await fill(page, '紧急联系人电话', '15500001234')
    expect(other.att).toMatchObject({ verified: true, strategy: 'locked-prefilled', display: '13800000000' })
    // 锁着又是空的：才是灰格子（在等前面的格子）
    const empty = await fill(page, '专业名称', '计算机科学与技术')
    expect(empty.att).toMatchObject({ verified: false, code: 'field_disabled' })
    await page.context().close()
  }, 60_000)
})

describe('手机验证码登录（真实 Chrome）', () => {
  it('他只管收验证码：切到手机号登录、填号、勾协议、点获取验证码；他报码后填上点登录；点了弹拼图如实报 captcha（2026-11-03 用户定）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/sms-login.html')
    const P = engine.fromPlaywright(page)
    const sent = await engine.prepareSmsLogin(P, '15500001234', { sleep: async () => {} })
    expect(sent).toEqual({ status: 'sent', agreed: true })
    expect(await page.evaluate(() => (window as unknown as { __sent: boolean }).__sent)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __leftPage: boolean }).__leftPage)).toBe(false) // 没点到协议链接
    expect(await engine.submitSmsCode(P, '123456')).toEqual({ ok: true })
    expect(await page.evaluate(() => (window as unknown as { __loggedIn: boolean }).__loggedIn)).toBe(true)
    const cap = await open('corpus/sms-login.html#captcha')
    expect(await engine.prepareSmsLogin(engine.fromPlaywright(cap), '15500001234', { sleep: async () => {} })).toMatchObject({ status: 'captcha' })
    // 岗位详情页：先点页面上的「登录」打开登录框，再照常发码
    const detail = await open('corpus/sms-login.html#detail')
    expect(await engine.prepareSmsLogin(engine.fromPlaywright(detail), '15500001234', { sleep: async () => {} })).toEqual({ status: 'sent', agreed: true })
    // 详情页「登录」过一会儿跳到独立登录页（2026-11-03 网易、理想）：等新页出来再找格子，不判成没有短信登录
    const nav = await open('corpus/nav-login.html')
    expect(await engine.prepareSmsLogin(engine.fromPlaywright(nav), '15500001234', { sleep: ms => nav.waitForTimeout(ms) })).toMatchObject({ status: 'sent' })
    expect(await nav.evaluate(() => (window as unknown as { __sentTo: string }).__sentTo)).toBe('15500001234')
    await nav.context().close()
    // 协议勾选只是画出来的小圆圈（2026-11-03 理想）：点圆圈勾上再发码；角上的二维码小图标不碰
    const icon = await open('corpus/icon-agree.html')
    expect(await engine.prepareSmsLogin(engine.fromPlaywright(icon), '15500001234', { sleep: async () => {} })).toEqual({ status: 'sent', agreed: true })
    expect(await icon.evaluate(() => (window as unknown as { __sentTo: string }).__sentTo)).toBe('15500001234')
    await icon.context().close()
    // 一层滑块盖住获取验证码：报要他过一下，不当成没有短信登录
    const covered = await open('corpus/sms-login.html#overlay')
    expect(await engine.prepareSmsLogin(engine.fromPlaywright(covered), '15500001234', { sleep: async () => {} })).toMatchObject({ status: 'captcha' })
    await page.context().close(); await cap.context().close(); await detail.context().close(); await covered.context().close()
  }, 90_000)
})

describe('邮箱验证码登录 / 注册（真实 Chrome）', () => {
  it('登录框只给扫码：点角标切账号登录 → 验证码登录（首次登录自动建号），填邮箱点获取验证码；码填上点登录（2026-11-03 中国中车）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/email-register.html')
    const P = engine.fromPlaywright(page)
    const account = { email: '15500001234@163.com', password: 'Abc2027abcd' }
    expect(await engine.prepareEmailRegister(P, account, { sleep: async () => {} })).toMatchObject({ status: 'sent', withPassword: false })
    expect(await page.evaluate(() => (window as unknown as { __sentTo: string }).__sentTo)).toBe('15500001234@163.com')
    expect(await engine.submitRegisterCode(P, '483920')).toEqual({ ok: true })
    expect(await page.evaluate(() => (window as unknown as { __registered: unknown }).__registered)).toEqual({ email: account.email, password: null })
    // 没有验证码登录、只能注册：填邮箱和密码、点获取激活码，激活码填上点注册
    const reg = await open('corpus/email-register.html#regonly')
    const R = engine.fromPlaywright(reg)
    expect(await engine.prepareEmailRegister(R, account, { sleep: async () => {} })).toMatchObject({ status: 'sent', withPassword: true })
    expect(await engine.submitRegisterCode(R, '483920')).toEqual({ ok: true })
    expect(await reg.evaluate(() => (window as unknown as { __registered: unknown }).__registered)).toEqual(account)
    // 框已经弹着、遮罩挡住导航上的「登录/注册」：短信那条路点不到也不报错，如实说没有短信登录；邮箱这条照样走通
    const open2 = await open('corpus/email-register.html#open')
    const P2 = engine.fromPlaywright(open2)
    expect(await engine.prepareSmsLogin(P2, '15500001234', { sleep: async () => {} })).toMatchObject({ status: 'no_sms' })
    expect(await engine.prepareEmailRegister(P2, account, { sleep: async () => {} })).toMatchObject({ status: 'sent' })
    // 点获取验证码弹出图形码：报 image_code，不碰它；他打错一次换一张，打对了发码，码照样填上登录
    const img = await open('corpus/email-register.html#imgcode')
    const I = engine.fromPlaywright(img)
    expect(await engine.prepareEmailRegister(I, account, { sleep: async () => {} })).toEqual({ status: 'image_code', withPassword: false })
    expect(await img.evaluate(() => (window as unknown as { __sentTo: string | null }).__sentTo)).toBeNull()
    expect(await engine.findImageCode(I)).toMatchObject({ image: '[data-career-imgcode="img"]' })
    // 看不清点图：网站上换一张，拿回来的是新图
    const oldImage = await engine.imageCodeDataUrl(I)
    const fresh = await engine.refreshImageCode(I, { sleep: ms => img.waitForTimeout(ms) })
    expect(fresh).toMatch(/^data:image\/png/)
    expect(fresh).not.toBe(oldImage)
    expect(await engine.answerImageCode(I, 'K7mP', { sleep: async () => {} })).toEqual({ status: 'image_code' }) // 旧图的字不对了
    // 他在网页上自己打字时（格子里有字）不算答完；还挂着图
    await img.fill('#i-code', 'Q3')
    expect(await engine.imageCodeGone(I)).toBe(false)
    await img.fill('#i-code', '')
    expect(await engine.answerImageCode(I, 'Q3zX', { sleep: async () => {} })).toEqual({ status: 'sent' })
    // 答对了那一行收起来：看得出他答完了（他直接在网页上答，产品那一格没收到字，2026-11-03 中国中车）
    expect(await engine.imageCodeGone(I)).toBe(true)
    expect(await engine.submitRegisterCode(I, '483920')).toEqual({ ok: true })
    expect(await img.evaluate(() => (window as unknown as { __registered: unknown }).__registered)).toEqual({ email: account.email, password: null })
    // 手机号 / 邮箱两个标签、默认在手机号（2026-11-03 畅游 Moka）：切到「邮箱登录」，不去点已经开着的「手机号登录」；
    // 点获取验证码弹拼图：报 captcha，由他拖，码照样发到邮箱
    const moka = await open('corpus/moka-login.html')
    const M = engine.fromPlaywright(moka)
    expect(await engine.prepareEmailRegister(M, account, { sleep: async () => {} })).toMatchObject({ status: 'captcha' })
    expect(await moka.inputValue('#m-mail')).toBe(account.email)
    await moka.context().close()
    // 扫码框没有角标、只有「其他登录方式」：也找得到账号登录，不在扫码那儿停
    const link = await open('corpus/email-register.html#qrlink')
    expect(await engine.prepareEmailRegister(engine.fromPlaywright(link), account, { sleep: async () => {} })).toMatchObject({ status: 'sent' })
    await link.context().close()
    // 存过账号密码：切到密码登录填上；密码登录也带图形码——报 image_code，他打的字填回去再点登录
    const pwd = await open('corpus/email-register.html')
    const W = engine.fromPlaywright(pwd)
    expect(await engine.preparePasswordLogin(W, { username: account.email, password: account.password }, { sleep: async () => {} })).toEqual({ status: 'image_code' })
    expect(await engine.submitPasswordLogin(W, 'ab12')).toEqual({ status: 'submitted' })
    expect(await pwd.evaluate(() => (window as unknown as { __pwdLogin: unknown }).__pwdLogin)).toEqual({ email: account.email, password: account.password, captcha: 'ab12' })
    await pwd.context().close()
    // 收码登录后弹「首次登录」只要设密码：填上生成的密码点确定；没有这个框就不动
    expect(await engine.setFirstPassword(P, 'Abc2027abcd')).toBe(false)
    const first = await open('corpus/email-register.html#firstpwd')
    const F = engine.fromPlaywright(first)
    expect(await engine.prepareEmailRegister(F, account, { sleep: async () => {} })).toMatchObject({ status: 'sent', withPassword: false })
    expect(await engine.submitRegisterCode(F, '483920')).toEqual({ ok: true })
    expect(await engine.setFirstPassword(F, 'Abc2027abcd')).toBe(true)
    expect(await first.evaluate(() => (window as unknown as { __registered: unknown }).__registered)).toEqual(account)
    await page.context().close(); await reg.context().close(); await open2.context().close(); await img.context().close(); await first.context().close()
  }, 90_000)
})

describe('固定顶栏挡住按钮（真实 Chrome）', () => {
  it('按钮停在固定顶栏下面：先滚到中间再点，不被顶栏挡住点到超时（2026-11-03 中国中车「立即投递」）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/fixed-header.html')
    await engine.fromPlaywright(page).click('#deliver')
    expect(await page.evaluate(() => (window as unknown as { __clicked: boolean }).__clicked)).toBe(true)
    await page.context().close()
  }, 30_000)
})

describe('字段编号稳定（真实 Chrome）', () => {
  it('页面顶上多出一格再抽一次：原来的格子号不变，新格子拿新号（2026-11-03 库洛游戏值全串到下一格）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/reflow-form.html')
    const P = engine.fromPlaywright(page)
    const before = Object.fromEntries((await engine.extractFields(P)).map(f => [f.label, f.id]))
    await page.click('#grow')
    const after = Object.fromEntries((await engine.extractFields(P)).map(f => [f.label, f.id]))
    expect(after['姓名']).toBe(before['姓名'])
    expect(after['邮箱']).toBe(before['邮箱'])
    expect(new Set(Object.values(after)).size).toBe(3)
    await P.fill(`[data-career-field="${after['姓名']}"]`, '周子航')
    expect(await page.inputValue('#name')).toBe('周子航')
    expect(await page.inputValue('#ref')).toBe('')
    await page.context().close()
  }, 30_000)
})

describe('问卷星上传（真实 Chrome）', () => {
  it('传完 input 被清空、文件名只在上传区：提交前不把已传好的简历报成必填空着（2026-11-02 中兵通信）', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const page = await open('corpus/wjx-questionnaire.html#uploaded')
    // 其余必填都填好（填完停在提交前的样子）
    await page.fill('#q1', '周子航'); await page.fill('#q3', '北京邮电大学'); await page.fill('#q5', '北京市海淀区')
    await page.click('#div2 .ui-radio'); await page.click('#div4 .ui-radio:nth-child(2)'); await page.selectOption('#q6', { label: '共青团员' })
    const filled = [{ fieldId: 'fx', label: '8.上传简历', value: '{{vault:profile.name}}-北京邮电大学-硕士.pdf', source: 'profile' as const }]
    const r = await engine.submitApplication(engine.fromPlaywright(page), { filled, timeoutMs: 500, pollMs: 100 })
    expect(r.missingRequired).not.toContain('8.上传简历')
    expect(r).toMatchObject({ status: 'submitted', button: '提交' }) // 提交按钮是 div 也找得到、点得到
    expect(r.agreed).toEqual(['我已阅读并同意']) // 他批准提交时一并勾上，记进回执
    // 页面上没有勾选框、点提交才弹「请阅读并同意」：点一次「同意并继续」
    const dlg = await open('corpus/wjx-questionnaire.html#uploaded-nocheckbox')
    await dlg.fill('#q1', '周子航'); await dlg.fill('#q3', '北京邮电大学'); await dlg.fill('#q5', '北京市海淀区')
    await dlg.click('#div2 .ui-radio'); await dlg.click('#div4 .ui-radio:nth-child(2)'); await dlg.selectOption('#q6', { label: '共青团员' })
    const r2 = await engine.submitApplication(engine.fromPlaywright(dlg), { filled, timeoutMs: 3000, pollMs: 100 })
    expect(r2).toMatchObject({ status: 'submitted', agreed: ['同意并继续'] })
    await dlg.context().close()
    // 没传过的那张表：照样报空
    const fresh = await open('corpus/wjx-questionnaire.html')
    expect((await engine.submitApplication(engine.fromPlaywright(fresh), { filled: [], timeoutMs: 500, pollMs: 100 })).missingRequired).toContain('8.上传简历')
    await page.context().close(); await fresh.context().close()
  }, 60_000)
})

describe('飞书 UD 下拉（真实 Chrome）', () => {
  it('选项包了 5 层的虚拟列表能逐项认出、点叶子选中、外壳里读回；禁用项不选；没有的值留空', async ({ skip }) => {
    if (!engine || !browser) return skip()
    const e = engine
    let page = await open('corpus/feishu-ud-select.html')
    // 2026-10-31 小鹏：整个列表被当成一个选项（「博士MBA硕士本科…」），学历、学历类型都没选上
    const P = e.fromPlaywright(page)
    const f = (await e.extractFields(P)).find(x => x.label === '学历')!
    const open1 = await P.evaluate(e.openOptionsScript, { selector: f.selector })
    expect(open1.options.map(o => o.text)).toEqual(['博士', 'MBA', '硕士', '本科', '大专', '高中', '专职', '初中', '小学'])
    expect(open1.options.find(o => o.text === '专职')?.disabled).toBe(true)
    expect(open1.partial).toBe(true) // 虚拟列表 30 项只渲染了 9 项：列表没露全
    await P.evaluate(e.closePopupScript, { selector: f.selector })
    // 9 项全渲染了、只是框不够高要滚动：列表是完整的
    const politics = (await e.extractFields(P)).find(x => x.label === '政治面貌')!
    expect((await P.evaluate(e.openOptionsScript, { selector: politics.selector })).partial).toBe(false)
    await P.evaluate(e.closePopupScript, { selector: politics.selector })
    let r = await fill(page, '学历', '本科')
    expect(r.att).toMatchObject({ verified: true })
    expect(r.model.degree).toBe('本科')
    expect(r.display).toBe('本科')
    // 填后检查重新抽取时也读得出选中值（不能把选好的「学历」报成必填还空着）
    expect((await e.extractFields(P)).find(x => x.label === '学历')?.value).toBe('本科')
    r = await fill(page, '学历类型', '统招全日制')
    expect(r.att).toMatchObject({ verified: true })
    expect(r.model.education_type).toBe('统招全日制')
    await page.context().close()
    page = await open('corpus/feishu-ud-select.html')
    r = await fill(page, '学历类型', '定向委培')
    left(r.att)
    expect(r.model.education_type).toBeUndefined()
    await page.context().close()
    // 要学生补的下拉：问之前点开读出选项再收起，跟着问题带过去（学历类型 5 项；禁用项不带）
    page = await open('corpus/feishu-ud-select.html')
    const P2 = e.fromPlaywright(page)
    const kind = (await e.extractFields(P2)).find(x => x.label === '学历类型')!
    const degree = (await e.extractFields(P2)).find(x => x.label === '学历')!
    const asked = await e.attachOptions(P2, [{ fieldId: kind.id, label: '学历类型', status: 'needs_user', source: 'none', confidence: 0 }, { fieldId: degree.id, label: '学历', status: 'needs_user', source: 'none', confidence: 0 }])
    expect(asked[0].options).toEqual(['海外及港澳台', '统招全日制', '统招非全日制', '自考', '其他'])
    expect(asked[1].options).toBeUndefined() // 学历虚拟列表只渲染了一部分：带一半会误导，不带
    await page.context().close()
    // 同一结构换一套不在组件库名单里的类名：外壳按结构往上找到最外层同类节点，选中值照样读得回来
    page = await open('corpus/feishu-ud-select.html?lib=zz')
    r = await fill(page, '学历', '本科')
    expect(r.att).toMatchObject({ verified: true })
    expect(r.display).toBe('本科')
    await page.context().close()
  }, 120_000)
})
