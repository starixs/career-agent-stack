import { describe, it, expect } from 'vitest'
import { Db, Repos, FILL_AUTO_RETRIED, autoRetryFailedFill, buildAsks, fillFailReason, isFillRetrying } from '../src/index.js'

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
    expect(of({ error: '该职位已停止招聘', summary: { status: 'blocked' } })).toBe('网站把这一步拦下了')
    expect(of({ error: '奇怪的错误' })).toBe('网站那边出了点问题')
    expect(fillFailReason({ result_json: null })).toBe('网站那边出了点问题')
  })
})
