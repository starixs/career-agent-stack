import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeLLM } from '@career/core'
import { FakePage, driveApplication, decideByRule, isUnsafeButton, isEntryText, maskValue, maskText, classifyError, RunRecorder, visionFill, type DialogInfo, type Profile } from '../src/index.js'
import { FakePerceiver } from '../src/perception.js'
import { profile, noLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const dlg = (text: string, buttons: string[], kind: 'dialog' | 'cookie' = 'dialog'): DialogInfo => ({ id: 'd0', text, kind, modal: true, buttons: buttons.map((t, i) => ({ id: `d0b${i}`, text: t, selector: `[data-career-dlg-btn="d0b${i}"]` })) })

describe('障碍层（弹窗 / 遮罩）', () => {
  it('规则：解析简历附件 → 否/仅上传；cookie → 仅必要；须知 → 我知道了；涉及同意 / 提交的不点', () => {
    expect(decideByRule(dlg('是否需要对简历附件进行解析并填充下方简历内容？', ['否，仅做附件上传', '是，需同步更新简历内容']))?.button.text).toBe('否，仅做附件上传')
    expect(decideByRule(dlg('我们使用 Cookie 改善体验', ['接受全部', '仅必要 Cookie'], 'cookie'))?.button.text).toBe('仅必要 Cookie')
    expect(decideByRule(dlg('温馨提示：请如实填写，虚假信息将取消资格', ['我知道了']))?.button.text).toBe('我知道了')
    expect(decideByRule(dlg('请阅读并同意《个人信息授权书》', ['同意并继续', '不同意']))).toBeNull()
    expect(decideByRule(dlg('温馨提示：确定删除这段教育经历吗？', ['确定', '取消']))?.button.text).not.toBe('确定')
    expect(isUnsafeButton('确认提交')).toBe(true); expect(isUnsafeButton('同意')).toBe(true); expect(isUnsafeButton('我知道了')).toBe(false)
  })

  it('上传后弹"是否解析附件"模态框：选「否，仅做附件上传」，然后其余字段正常填写（不再 8 秒超时）', async () => {
    const page = new FakePage({
      url: 'https://zhaopin.meituan.com/web/delivery',
      fields: [{ label: '上传简历附件', type: 'file' }, { label: '姓名' }, { label: '邮箱' }],
      uploadEcho: f => `${f} 已上传`,
      dialogs: [{ text: '是否需要对简历附件进行解析并填充下方简历内容？', buttons: ['否，仅做附件上传', '是，需同步更新简历内容'], afterUpload: true }],
      buttons: [{ text: '投递', submit: true }],
    })
    const progress: string[] = []
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, humanTyping: true, onProgress: p => progress.push(p.message) })
    expect(page.dialogChoices).toEqual(['否，仅做附件上传'])
    expect(r.blockers).toEqual([expect.objectContaining({ choice: '否，仅做附件上传', by: 'rule', resolved: true })])
    expect(page.fieldValues()).toMatchObject({ 姓名: '张三', 邮箱: 'zhangsan@example.com' })
    expect(r.status).toBe('stopped_before_submit'); expect(page.submitted).toBe(false)
    expect(progress).toContain('弹窗：已选「否，仅做附件上传」')
    expect(progress).toContain('正在填「姓名」')
    expect(progress.join('\n')).not.toMatch(/Timeout|locator|intercepts/)
  })

  it('未知弹窗：模型在按钮里挑安全的；模型挑了"同意"也不点 → 交给用户', async () => {
    const mk = () => new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }], dialogs: [{ text: '本次活动说明 请选择您的意向', buttons: ['稍后再看', '同意并授权'] }], buttons: ['提交'] })
    const p1 = mk()
    const r1 = await driveApplication(p1, new FakeLLM([JSON.stringify({ choice: 0, reason: '只是关闭' })]), profile, quiet)
    expect(p1.dialogChoices).toEqual(['稍后再看'])
    expect(r1.blockers[0]).toMatchObject({ by: 'llm', resolved: true })
    expect(r1.status).toBe('stopped_before_submit')
    const p2 = mk()
    const r2 = await driveApplication(p2, new FakeLLM([JSON.stringify({ choice: 1 })]), profile, quiet)
    expect(p2.dialogChoices).toEqual([])
    expect(r2.status).toBe('handoff'); expect(r2.reason).toBe('user_request')
    expect(r2.userAction).toContain('本次活动说明')
  })
})

describe('第二重：宁空不错 / 不假成功', () => {
  it('永远选不中的下拉 → needs_user（option_not_selected），不是 ok；不算已填', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '学历', type: 'select', options: ['本科', '硕士研究生', '博士研究生'], framework: 'mtd', readonly: true, neverSelects: true, required: true }, { label: '姓名' }], buttons: [{ text: '投递', submit: true }] })
    const r = await driveApplication(page, noLLM(), { ...profile, basics: { ...profile.basics, degree: '硕士' } }, quiet)
    expect(r.filled.map(f => f.label)).toEqual(['姓名'])
    expect(r.needsUser).toEqual([expect.objectContaining({ label: '学历', code: 'option_not_selected' })])
    expect(r.fields.find(f => f.label === '学历')).toMatchObject({ status: 'needs_user', verified: false, code: 'option_not_selected' })
    expect(r.review?.rows.find(x => x.label === '学历')).toMatchObject({ status: 'needs_user', reasonCode: 'option_not_selected' })
    expect(r.review?.attention).toBeGreaterThan(0)
    // 只读的自定义下拉绝不走原生赋值
    expect(page.actions.some(a => a.kind === 'fill' && a.target === 'f0')).toBe(false)
  })

  it('选项里没有对得上的 → no_matching_option，问过模型也拿不准就留空', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '学历', type: 'select', options: ['大专', '本科'], framework: 'mtd' }], buttons: ['提交'] })
    const llm = new FakeLLM([JSON.stringify({ index: null })])
    const r = await driveApplication(page, llm, { ...profile, basics: { ...profile.basics, degree: '博士' } }, quiet)
    expect(page.valueOf('学历')).toBeUndefined()
    expect(r.needsUser[0]).toMatchObject({ label: '学历', code: 'no_matching_option' })
    expect(llm.calls.length).toBe(1)
  })

  it('学历字段填不上时，教育经历分区不会再往同一格塞别的值（GPA 进学历的根因）', async () => {
    const page = new FakePage({
      url: 'https://x.com/apply',
      fields: [{ label: '学校名称' }, { label: '专业名称' }, { label: '学历', type: 'select', options: ['本科', '硕士'], framework: 'mtd', neverSelects: true }],
      buttons: [{ text: '投递', submit: true }],
    })
    const p: Profile = { ...profile, basics: { ...profile.basics, degree: '硕士' }, education: [{ school: '清华大学', major: '电子信息', degree: 'GPA 4.60/5.0；获国家奖学金' }] }
    const r = await driveApplication(page, noLLM(), p, quiet)
    const optionClicks = page.actions.filter(a => a.kind === 'option' && a.target === 'f2')
    expect(optionClicks.length).toBe(1) // 只有字段阶段那一次
    expect(r.filled.filter(f => f.fieldId === 'f2')).toEqual([])
    expect(new Set(r.filled.map(f => f.fieldId)).size).toBe(r.filled.length) // 同一字段只记一次
  })

  it('标签可疑（吸顶栏文字）的字段不按它填：needs_user + label_uncertain', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: 'LongCat人才招聘', labelUncertain: '标签像导航栏 / 站点名' }, { label: '姓名' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), { ...profile, basics: { ...profile.basics, 'LongCat人才招聘': 'x' } }, { ...quiet, interpret: { recallKey: f => (f.label.startsWith('LongCat') ? 'school' : undefined) } })
    expect(page.valueOf('LongCat人才招聘')).toBeUndefined()
    expect(r.needsUser).toEqual([expect.objectContaining({ code: 'label_uncertain' })])
    expect(r.fields.find(f => f.fieldId === 'f0')?.labelUncertain).toBeTruthy()
  })

  it('审阅：选填留空标 empty_optional（不算 ok、不算要人看）；必填标记对不上时 requiredTrusted=false', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', required: true }, { label: '导师' }, { label: '研究方向' }], requiredMarkers: 3, buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    const rows = r.review!.rows
    expect(rows.find(x => x.label === '导师')).toMatchObject({ status: 'empty_optional', required: false })
    expect(rows.find(x => x.label === '导师')?.verified).toBeUndefined()
    expect(rows.find(x => x.label === '姓名')).toMatchObject({ status: 'ok', verified: true })
    expect(r.review).toMatchObject({ attention: 0, optionalEmpty: 2, requiredTotal: 1, requiredFilled: 1, requiredTrusted: false, verified: true })
    expect(r.review?.requiredNote).toContain('3 个必填星号')
    expect(r.fields.find(f => f.label === '导师')?.status).toBe('empty_optional')
  })

  it('视觉层：点到的不是可编辑元素就一个键都不按（不会 Meta+A 全选整页）', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '学历', type: 'select', options: ['本科'], box: [140, 96, 240, 32], domHidden: true }] })
    const perceiver = new FakePerceiver({ source: 'fake', viewport: { width: 1280, height: 800 }, elements: [{ id: 'l', kind: 'text', text: '学历', box: { x: 40, y: 100, w: 80, h: 24 } }, { id: 'i', kind: 'select', text: '', box: { x: 140, y: 96, w: 240, h: 32 } }] })
    const r = await visionFill(page as never, { perceiver, pause: [0, 0], sleep: async () => {} }, '学历', '本科')
    expect(page.actions.some(a => a.kind === 'press')).toBe(false)
    expect(page.actions.some(a => a.kind === 'type')).toBe(false)
    expect(r.ok).toBe(false)
  })

  it('原因码：Playwright 英文报错映射成中文，原文不进结果', async () => {
    expect(classifyError(new Error('locator.click: Timeout 8000ms exceeded.\n <div class="mtd-modal-mask"></div> subtree intercepts pointer events')).code).toBe('blocked_by_overlay')
    expect(classifyError(new Error('locator.fill: Timeout 8000ms exceeded.')).code).toBe('timeout')
    expect(isEntryText('立即申请')).toBe(true); expect(isEntryText('投递')).toBe(false); expect(isEntryText('立即投递')).toBe(false); expect(isEntryText('确认提交')).toBe(false)
  })
})

describe('遥测（运行记录）', () => {
  it('每次 drive 写 trace.jsonl / summary.json / 截图，敏感值打码；只保留最近 N 次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'career-runs-'))
    for (let i = 0; i < 3; i++) mkdirSync(join(root, `old${i}`))
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '手机号', type: 'tel' }, { label: '学历', type: 'select', options: ['本科'], framework: 'mtd', neverSelects: true }], libraries: ['mtd'], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, telemetry: { dir: root, runId: 'act_test1', keep: 2 } })
    expect(r.telemetry).toEqual({ dir: join(root, 'act_test1'), runId: 'act_test1' })
    const dir = join(root, 'act_test1')
    const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(trace.some(t => t.stage === 'field' && t.label === '学历' && t.result === 'fail' && t.code === 'option_not_selected')).toBe(true)
    const phone = trace.find(t => t.stage === 'field' && t.label === '手机号')
    expect(phone.value).toBe('138***00')
    expect(readFileSync(join(dir, 'trace.jsonl'), 'utf8')).not.toContain('13800000000')
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ runId: 'act_test1', host: 'x.com', libraries: ['mtd'], status: 'stopped_before_submit', codes: { option_not_selected: 1 } })
    expect(summary.fields).toMatchObject({ total: 2, verified: 1, needsUser: 1 })
    expect(readdirSync(dir).some(f => f.endsWith('.jpg'))).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['act_test1', 'old2'].sort().filter(n => existsSync(join(root, n))))
    expect(readdirSync(root).length).toBe(2)
  })
  it('打码：手机 / 邮箱 / 身份证只留前后几位', () => {
    expect(maskValue('邮箱', 'zhangsan@example.com')).toBe('zha***om')
    expect(maskText('电话 13800000000 邮箱 zhangsan@example.com 身份证 110101199001011234')).toBe('电话 138****00 邮箱 zh***@example.com 身份证 110***********1234')
    expect(new RunRecorder({ dir: '/nonexistent-root/\u0000bad', runId: 'x' }).dir).toContain('x') // 写盘失败也不抛
  })
})
