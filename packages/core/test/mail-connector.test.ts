import { describe, it, expect } from 'vitest'
import { Db, Repos } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('邮箱连接器数据', () => {
  it('新账号带健康计数，状态字段可写回', () => {
    const r = mem()
    const a = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    expect(a).toMatchObject({ consecutive_fails: 0, last_ok_at: null, uidvalidity: null })
    r.updateMailAccount(a.id, { consecutive_fails: 2, uidvalidity: 1700000000, last_check_at: '2026-10-30T01:00:00Z' })
    expect(r.getMailAccount(a.id)).toMatchObject({ consecutive_fails: 2, uidvalidity: 1700000000 })
  })

  it('同账号同 Message-ID 只存一次（邮箱重建后 uid 重新编号）', () => {
    const r = mem()
    const a = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    const base = { account_id: a.id, message_id: '<m1@x>', in_reply_to: null, direction: 'in' as const, from_addr: null, to_addr: null, subject: 's', snippet: null, body_text: null, received_at: null, relevance: 'unknown' as const, kind: null, inbox_item_id: null, application_id: null, action_id: null }
    expect(r.insertMailMessage({ ...base, uid: 5 })).not.toBeNull()
    expect(r.insertMailMessage({ ...base, uid: 1 })).toBeNull()
  })

  it('操作留痕：按时间倒序列出，近 N 天按操作计数，删账号连带删除', () => {
    const r = mem()
    const a = r.upsertMailAccount({ provider: '163', address: 'me@163.com', imap_host: 'imap.163.com', smtp_host: 'smtp.163.com' })
    r.addMailAudit({ account_id: a.id, actor: 'system', operation: 'sync', status: 'ok', detail: { fetched: 3 }, latency_ms: 800 })
    r.addMailAudit({ account_id: a.id, actor: 'agent', operation: 'send', status: 'ok', detail: { to: ['hr@x.com'] } })
    r.addMailAudit({ account_id: a.id, actor: 'system', operation: 'sync', status: 'failed' })
    expect(r.listMailAudit(a.id).map(x => x.operation)).toHaveLength(3)
    const usage = r.mailUsage(a.id, '2000-01-01T00:00:00Z')
    expect(usage.find(u => u.operation === 'sync' && u.status === 'ok')?.n).toBe(1)
    r.deleteMailAccount(a.id)
    expect(r.listMailAudit(a.id)).toEqual([])
  })
})

describe('云端连接的本机镜像', () => {
  const remote = { remote_id: 'conn_1', provider: 'qq' as const, address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com', status: 'ok', last_error: null, consecutive_fails: 0, last_ok_at: null, last_check_at: null, last_sync_at: null, created_at: '2026-10-30T00:00:00Z' }
  it('按 remote_id 更新同一行；本地连过的同一地址会被认领', () => {
    const r = mem()
    const local = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    expect(r.mirrorMailAccount(remote).id).toBe(local.id)
    const b = r.mirrorMailAccount({ ...remote, status: 'auth_failed', consecutive_fails: 3 })
    expect(b).toMatchObject({ id: local.id, remote_id: 'conn_1', status: 'auth_failed', consecutive_fails: 3 })
    expect(r.getMailAccountByRemote('conn_1')?.id).toBe(local.id)
    expect(r.listMailAccounts()).toHaveLength(1)
  })
})

describe('今日队列 · 邮箱连接失效', () => {
  it('失效的邮箱排在最前，其他事都在它后面；正常的邮箱不进队列', () => {
    const r = mem()
    const ok = r.upsertMailAccount({ provider: '163', address: 'ok@163.com', imap_host: 'imap.163.com', smtp_host: 'smtp.163.com' })
    r.updateMailAccount(ok.id, { status: 'ok' })
    const bad = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    r.updateMailAccount(bad.id, { status: 'auth_failed', consecutive_fails: 3 })
    r.createDeadline({ kind: 'assessment', title: '甲公司测评', due_at: '2026-10-01T00:00:00Z', source: 'manual' })
    const items = r.today('2026-10-30T08:00:00Z').items
    expect(items[0]).toMatchObject({ kind: 'mail_auth', priority: 0, ref: { type: 'mail_account', id: bad.id } })
    expect(items.slice(1).map(i => i.kind)).toContain('deadline')
    expect(items.filter(i => i.kind === 'mail_auth')).toHaveLength(1)
  })
})
