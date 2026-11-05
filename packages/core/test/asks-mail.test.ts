import { describe, it, expect } from 'vitest'
import { Db, Repos, buildAsks, MAIL_AUTH_FAILED_REASON, MAIL_SEND_FAILED_REASON, MAIL_SEND_INTERRUPTED_REASON } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }
const NOW = '2026-11-05T08:00:00.000Z'

function mailApp(r: Repos, company: string) {
  const job = r.upsertJob({ source_platform: 'manual', source_job_id: company, title: '产品实习生', company_name: company, apply_email: `hr@${company}.com` })
  return r.createApplication(job.id)
}
const pendingMail = (r: Repos, appId: string, purpose?: 'apply' | 'followup' | 'reply') =>
  r.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘', body: '正文', application_id: appId, ...(purpose ? { purpose } : {}) }, appId)

describe('等你条 · 邮件投递', () => {
  it('1 封投递邮件：「{公司} · 邮件写好了」，带 mail 不带内容', () => {
    const r = mem()
    const app = mailApp(r, '甲公司')
    const a = pendingMail(r, app.id, 'apply')
    const asks = buildAsks(r, NOW)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'review', id: a.id, title: '甲公司 · 邮件写好了', mail: { purpose: 'apply', action_ids: [a.id] }, application_ids: [app.id] })
    expect(JSON.stringify(asks[0])).not.toContain('hr@x.com')
    expect(JSON.stringify(asks[0])).not.toContain('正文')
  })

  it('≥2 封投递邮件合成一件「N 封邮件写好了」，公司与动作全列；没写用途的老动作算投递', () => {
    const r = mem()
    const ids = ['甲', '乙', '丙'].map((c, i) => pendingMail(r, mailApp(r, c).id, i === 2 ? undefined : 'apply').id)
    const asks = buildAsks(r, NOW)
    expect(asks).toHaveLength(1)
    expect(asks[0].title).toBe('3 封邮件写好了')
    expect(asks[0].mail).toEqual({ purpose: 'apply', action_ids: ids })
    expect(asks[0].sources.map(s => s.id)).toEqual(ids)
    expect(asks[0].companies.map(c => c.name)).toEqual(['甲', '乙', '丙'])
    expect(asks[0].application_ids).toHaveLength(3)
  })

  it('跟进 / 回信一封一件，不并进投递那件', () => {
    const r = mem()
    pendingMail(r, mailApp(r, '甲').id, 'apply')
    pendingMail(r, mailApp(r, '乙').id, 'apply')
    const f = pendingMail(r, mailApp(r, '丙').id, 'followup')
    const re = pendingMail(r, mailApp(r, '丁').id, 'reply')
    const asks = buildAsks(r, NOW)
    expect(asks.map(a => a.title).sort()).toEqual(['2 封邮件写好了', '丁 回信了', '丙 · 一周没回音'].sort())
    expect(asks.find(a => a.id === f.id)?.mail).toEqual({ purpose: 'followup', action_ids: [f.id] })
    expect(asks.find(a => a.id === re.id)?.mail).toEqual({ purpose: 'reply', action_ids: [re.id] })
  })

  it('批准后退回待审的写邮件：并进「N 家等你说开始」', () => {
    const r = mem()
    const fill = r.enqueueAction('fill_form', { url: 'https://a.com' }, mailApp(r, '甲').id)
    const draft = r.enqueueAction('draft_mail', { to: 'hr@b.com' }, mailApp(r, '乙').id)
    const asks = buildAsks(r, NOW)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'start', title: '2 家等你说开始' })
    expect(asks[0].sources.map(s => s.id)).toEqual([fill.id, draft.id])
  })

  it('发送失败：授权类与其余分成两件「N 封没发出去」，带 mail_failed；重发之后旧失败不再出现', () => {
    const r = mem()
    const a1 = pendingMail(r, mailApp(r, '甲').id, 'apply')
    const a2 = pendingMail(r, mailApp(r, '乙').id, 'apply')
    const a3 = pendingMail(r, mailApp(r, '丙').id, 'apply')
    r.setActionStatus(a1.id, 'failed', { error: 'Invalid login: 535 Login fail' })
    r.setActionStatus(a2.id, 'failed', { error: 'connect ETIMEDOUT' })
    r.setActionStatus(a3.id, 'failed', { error: MAIL_SEND_INTERRUPTED_REASON })
    let asks = buildAsks(r, NOW)
    const failed = asks.filter(a => a.kind === 'failed')
    expect(failed).toHaveLength(2)
    const auth = failed.find(a => a.mail_failed?.reauth)!
    expect(auth).toMatchObject({ title: '1 封没发出去', detail: MAIL_AUTH_FAILED_REASON, action_ids: [a1.id], mail_failed: { stage: 'send', reauth: true } })
    const other = failed.find(a => !a.mail_failed?.reauth)!
    expect(other).toMatchObject({ title: '2 封没发出去', detail: `${MAIL_SEND_FAILED_REASON}、${MAIL_SEND_INTERRUPTED_REASON}`, action_ids: [a2.id, a3.id], mail_failed: { stage: 'send', reauth: false } })
    expect(auth.mail).toBeUndefined()
    // 再发一次 = 放回待审：失败那件消失，变成待过目
    for (const a of [a1, a2, a3]) r.reopenAction(a.id)
    asks = buildAsks(r, NOW)
    expect(asks.some(a => a.kind === 'failed')).toBe(false)
    expect(asks.find(a => a.mail)?.title).toBe('3 封邮件写好了')
  })

  it('退信后待重发的那封单独一件「{公司} · 邮件被退回」，mail.bounced，不并进投递那件', () => {
    const r = mem()
    pendingMail(r, mailApp(r, '甲').id, 'apply')
    pendingMail(r, mailApp(r, '乙').id, 'apply')
    const app = mailApp(r, '丙')
    const b = r.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘', body: '正文', application_id: app.id, purpose: 'apply', bounced_from: 'hr@x.com' }, app.id)
    const asks = buildAsks(r, NOW)
    expect(asks.map(a => a.title).sort()).toEqual(['2 封邮件写好了', '丙 · 邮件被退回'].sort())
    expect(asks.find(a => a.id === b.id)?.mail).toEqual({ purpose: 'apply', action_ids: [b.id], bounced: true })
  })

  it('跟进 / 回信发送失败：投出之后照样出声，和投递那封各算各的', () => {
    const r = mem()
    const app = mailApp(r, '甲')
    const sent = pendingMail(r, app.id, 'apply')
    r.setActionStatus(sent.id, 'done')
    r.jumpTo(app.id, 'applied')
    const f = pendingMail(r, app.id, 'followup')
    r.setActionStatus(f.id, 'failed', { error: 'connect ETIMEDOUT' })
    expect(buildAsks(r, NOW).find(a => a.kind === 'failed')).toMatchObject({ title: '1 封没发出去', action_ids: [f.id] })
    r.jumpTo(app.id, 'rejected')
    expect(buildAsks(r, NOW).some(a => a.kind === 'failed')).toBe(false)
  })

  it('写邮件失败：「N 封没写成」，原因用落库的那句人话；已投出的不再提', () => {
    const r = mem()
    const app = mailApp(r, '甲')
    const d = r.enqueueAction('draft_mail', { to: 'hr@a.com' }, app.id, true)
    r.setActionStatus(d.id, 'failed', { error: '这份简历没备好' })
    const f = buildAsks(r, NOW).find(a => a.kind === 'failed')!
    expect(f).toMatchObject({ title: '1 封没写成', detail: '这份简历没备好', action_ids: [d.id], mail_failed: { stage: 'draft', reauth: false } })
    expect(r.retryFailedDraft(d.id)).toBe(true)
    expect(r.getAction(d.id)!.status).toBe('approved')
    r.setActionStatus(d.id, 'failed', { error: '没写成' })
    r.jumpTo(app.id, 'applied')
    expect(buildAsks(r, NOW).some(a => a.kind === 'failed')).toBe(false)
  })
})
