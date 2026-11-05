import { describe, it, expect } from 'vitest'
import { Db, Repos, FILL_AUTO_RETRIED, NO_FORM_REASON, PACKET_FAILED_CODE, autoRetryFailedFill, buildAsks, closeIfJobEnded, fillFailReason, isFillRetrying, jobClosedEvidence } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }
const NOW = '2026-11-05T08:00:00.000Z'

/** 一份投递：批准的填表动作跑起来后失败（和 drive-outcome 的 fail 一样：动作 failed、投递 blocked）。 */
function failedFill(r: Repos, company: string, error: string) {
  const job = r.upsertJob({ source_platform: 'campus', source_job_id: company, title: '产品实习', company_name: company, url: `https://${company}.com/apply` })
  const app = r.createApplication(job.id)
  r.jumpTo(app.id, 'approved')
  const action = r.enqueueAction('fill_form', { url: `https://${company}.com/apply`, job_id: job.id }, app.id, true)
  fail(r, action.id, app.id, error)
  return { app, action }
}
function fail(r: Repos, actionId: string, appId: string, error: string) {
  r.setActionStatus(actionId, 'executing')
  r.transition(appId, 'pending')
  r.setActionStatus(actionId, 'failed', { error })
  r.transition(appId, 'blocked', error)
}

describe('填表失败：自动再试一次，再失败进等你', () => {
  it('每份投递只自动再试一次；再试期间算「正在再试」；再失败交给等你', () => {
    const r = mem()
    const { app, action } = failedFill(r, '甲', 'Timeout 30000ms exceeded')
    expect(autoRetryFailedFill(r, action.id)).toBe('retrying')
    expect(r.getAction(action.id)!.status).toBe('approved')
    expect(r.getApplication(app.id)!.retry_strategy).toBe(FILL_AUTO_RETRIED)
    expect(isFillRetrying(r, r.getAction(action.id)!)).toBe(true)
    expect(buildAsks(r, NOW).some(a => a.kind === 'failed')).toBe(false)

    fail(r, action.id, app.id, 'Timeout 30000ms exceeded')
    expect(autoRetryFailedFill(r, action.id)).toBe('exhausted')
    expect(r.getAction(action.id)!.status).toBe('failed')
    expect(isFillRetrying(r, r.getAction(action.id)!)).toBe(false)
  })

  it('批准失效（内容改过）的没法原样重跑：不放回队列', () => {
    const r = mem()
    const { action } = failedFill(r, '乙', 'boom')
    r.db.run('UPDATE action_queue SET approved_hash=NULL WHERE id=?', [action.id])
    expect(autoRetryFailedFill(r, action.id)).toBe('not_retryable')
    expect(autoRetryFailedFill(r, 'act_missing')).toBe('not_retryable')
  })

  it('几家没填成合成一件「N 家没填成」，原因说人话；重试或接管后就不在了', () => {
    const r = mem()
    const a = failedFill(r, '甲', 'page.goto: Timeout 30000ms exceeded')
    const b = failedFill(r, '乙', "locator('#major') not found")
    const asks = buildAsks(r, NOW).filter(x => x.kind === 'failed')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'failed', title: '2 家没填成', detail: '页面一直没打开、有一格我填不上' })
    expect(asks[0].application_ids.sort()).toEqual([a.app.id, b.app.id].sort())
    expect(asks[0].action_ids!.sort()).toEqual([a.action.id, b.action.id].sort())
    expect(asks[0].sources.every(s => s.type === 'action')).toBe(true)
    expect(asks[0].url).toBeUndefined()

    r.retryFailedFill(a.action.id)
    r.transition(a.app.id, 'pending')
    const left = buildAsks(r, NOW).find(x => x.kind === 'failed')!
    expect(left).toMatchObject({ title: '1 家没填成', application_ids: [b.app.id], url: 'https://乙.com/apply' })
  })

  it('原因归类：打不开 / 填不上 / 浏览器断了 / 网站拦下 / 其他', () => {
    const of = (result: unknown) => fillFailReason({ result_json: JSON.stringify(result) })
    expect(of({ error: '连续 3 次打不开这家网申页面：net::ERR_TIMED_OUT' })).toBe('页面一直没打开')
    expect(of({ error: 'Field 学历 could not be filled' })).toBe('有一格我填不上')
    expect(of({ error: '浏览器没有返回填表结果' })).toBe('浏览器中途断了')
    expect(of({ error: '该职位已停止招聘', summary: { status: 'blocked' } })).toBe('岗位已结束招聘')
    expect(of({ error: '页面上没有找到可填写的网申表单，也没有下一步或提交按钮', summary: { status: 'blocked' } })).toBe(NO_FORM_REASON)
    expect(of({ error: '页面上没有可填写的表单字段' })).toBe(NO_FORM_REASON)
    expect(of({ error: 'blocked', summary: { status: 'blocked' } })).toBe('网站把这一步拦下了')
    expect(of({ error: '奇怪的错误' })).toBe('网站那边出了点问题')
    expect(fillFailReason({ result_json: null })).toBe('网站那边出了点问题')
  })

  it('已结束的岗位不算没填成：投递关掉、不进「N 家没填成」；引擎亲口说的才把岗位标关闭（风险 E#1）', () => {
    const r = mem()
    const ended = failedFill(r, '甲', '页面上没有可填写的表单字段')
    r.setActionStatus(ended.action.id, 'failed', { error: '页面上没有可填写的表单字段', summary: { status: 'blocked', pageText: '很抱歉，该岗位招聘已结束' } })
    const said = failedFill(r, '丙', '该职位已停止招聘')
    const other = failedFill(r, '乙', 'Timeout 30000ms exceeded')
    // 对话里跑的那份还没被关掉时，等你里也不出它
    expect(buildAsks(r, NOW).find(a => a.kind === 'failed')?.application_ids).toEqual([other.app.id])
    expect(closeIfJobEnded(r, ended.action.id)).toBe(true)
    expect(r.getApplication(ended.app.id)!.stage).toBe('skip')
    // 只凭页面正文认出的：投递跳过，岗位库不动
    expect(r.getJob(ended.app.job_id)!.source_status).not.toBe('closed')
    expect(closeIfJobEnded(r, said.action.id)).toBe(true)
    expect(r.getJob(said.app.job_id)!.source_status).toBe('closed')
    expect(closeIfJobEnded(r, other.action.id)).toBe(false)
    expect(r.getApplication(other.app.id)!.stage).toBe('blocked')
  })

  it('门户页里有"往期已结束"不算岗位关闭', () => {
    const page = (pageText: string) => jobClosedEvidence({ result_json: JSON.stringify({ error: '页面上没有可填写的表单字段', summary: { status: 'blocked', pageText } }) })
    expect(page('校园招聘 | 往期已结束 | 已截止岗位不显示')).toBeNull()
    expect(page('2027 届校园招聘，招聘截止时间：2026-12-01')).toBeNull()
    expect(page('很抱歉，该岗位已结束')).toBe('page')
    expect(page('本次报名已截止')).toBe('page')
    expect(page('职位关闭')).toBe('page')
    const r = mem()
    const portal = failedFill(r, '丁', '页面上没有可填写的表单字段')
    r.setActionStatus(portal.action.id, 'failed', { error: '页面上没有可填写的表单字段', summary: { status: 'blocked', pageText: '校园招聘 往期已结束' } })
    expect(closeIfJobEnded(r, portal.action.id)).toBe(false)
    expect(r.getApplication(portal.app.id)!.stage).toBe('blocked')
    expect(buildAsks(r, NOW).find(a => a.kind === 'failed')?.application_ids).toEqual([portal.app.id])
  })

  it('材料包没备出来：不自动再试，「N 家没填成」里原样说原因', () => {
    const r = mem()
    const { action } = failedFill(r, '戊', '简历 PDF 没导出来')
    r.setActionStatus(action.id, 'failed', { error: '简历 PDF 没导出来', code: PACKET_FAILED_CODE })
    expect(autoRetryFailedFill(r, action.id)).toBe('not_retryable')
    expect(r.getAction(action.id)!.status).toBe('failed')
    expect(buildAsks(r, NOW).find(a => a.kind === 'failed')?.detail).toBe('简历 PDF 没导出来')
  })

  it('开放题全是写好的草稿：标题说「N 道开放题写好了，看一眼」（风险 E#12）', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'campus', source_job_id: 'q', title: '产品实习', company_name: '丙', url: 'https://q.com/apply' })
    const app = r.createApplication(job.id)
    const a = r.enqueueAction('fill_form', { job_id: job.id }, app.id, true)
    r.openHandoff('missing_info', { actionId: a.id, message: '还差 2 项' })
    const labels = ['你为什么选择我们？', '说说你最有成就感的一件事']
    r.setActionStatus(a.id, 'needs_user', {
      needsUser: labels.map(label => ({ label })),
      drafts: labels.map(label => ({ label, value: '草稿一版' })),
      gate: { gaps: labels.map(label => ({ label, status: 'needs_user', required: true })) },
    })
    expect(buildAsks(r, NOW).find(x => x.kind === 'info')?.title).toBe('2 道开放题写好了，看一眼')
  })
})
