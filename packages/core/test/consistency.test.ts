import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Db, Repos, MIGRATIONS, runMigrations, currentVersion, hasColumn, canonicalJson, jobKey, sha256 } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('增量迁移', () => {
  it('新库：基线 + 全部迁移，版本号连续', () => {
    const r = mem()
    expect(currentVersion(r.db.raw)).toBe(Math.max(...MIGRATIONS.map(m => m.version)))
    expect(hasColumn(r.db.raw, 'action_queue', 'approved_hash')).toBe(true)
    expect(hasColumn(r.db.raw, 'job', 'job_key')).toBe(true)
  })

  it('老库（只有 version=1、旧表结构）打开时补列，数据不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'career-mig-'))
    const path = join(dir, 'old.sqlite')
    const raw = new DatabaseSync(path)
    // 模拟 v1 时代的库：旧版 action_queue / job 没有新列
    raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '2026-10-01');
      CREATE TABLE action_queue (id TEXT PRIMARY KEY, application_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending_review', result_json TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO action_queue(id, kind, payload_json, status, created_at, updated_at) VALUES ('act_old', 'send_mail', '{"to":"hr@x.com"}', 'approved', 'a', 'a');`)
    raw.close()
    const db = new Db(path); db.migrate()
    expect(currentVersion(db.raw)).toBeGreaterThanOrEqual(2)
    const row = db.get<{ id: string; approved_hash: string | null; status: string }>('SELECT * FROM action_queue WHERE id=?', ['act_old'])!
    expect(row.status).toBe('approved')
    expect(row.approved_hash).toBeNull()
    // 旧的"已批准"没有内容哈希 → 执行前认领会退回待审，必须重新批准
    const r = new Repos(db)
    const c = r.claimAction('act_old')
    expect(c.ok).toBe(false)
    expect(r.getAction('act_old')!.status).toBe('pending_review')
    db.close()
  })

  it('迁移只跑一次；失败整体回滚', () => {
    const r = mem()
    expect(runMigrations(r.db.raw)).toEqual([])
    const bad = [{ version: 999, name: 'bad', up: (d: DatabaseSync) => { d.exec('CREATE TABLE tmp_x (id TEXT)'); throw new Error('boom') } }]
    expect(() => runMigrations(r.db.raw, bad)).toThrow(/v999/)
    expect(r.db.get(`SELECT name FROM sqlite_master WHERE name='tmp_x'`)).toBeUndefined()
  })

  it('schema.sql 基线里没有迁移才加的列（避免基线与迁移两处漂移）', () => {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'), 'utf8')
    expect(sql).not.toMatch(/approved_hash|job_key|application_packet/)
  })
})

describe('审批绑定内容', () => {
  it('只有待审能被批准；已执行的动作不能被再次批准（防重复发送）', () => {
    const r = mem()
    const a = r.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘' })
    expect(a.status).toBe('pending_review')
    expect(r.reviewActions([a.id], 'approved')).toBe(1)
    expect(r.claimAction(a.id).ok).toBe(true)
    r.setActionStatus(a.id, 'done')
    expect(r.reviewActions([a.id], 'approved')).toBe(0)
    expect(r.getAction(a.id)!.status).toBe('done')
    expect(r.claimAction(a.id).ok).toBe(false)
  })

  it('同一动作只能被认领一次（批量与对话同时执行时只有一个能拿到）', () => {
    const r = mem()
    const a = r.enqueueAction('fill_form', { job_id: 'j1' })
    r.reviewActions([a.id], 'approved')
    expect(r.claimAction(a.id).ok).toBe(true)
    const second = r.claimAction(a.id)
    expect(second.ok).toBe(false)
  })

  it('批准后内容被改：执行前发现并退回待审', () => {
    const r = mem()
    const a = r.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘' })
    r.reviewActions([a.id], 'approved', 'user')
    expect(r.getAction(a.id)!.approved_by).toBe('user')
    r.db.run('UPDATE action_queue SET payload_json=? WHERE id=?', [canonicalJson({ to: 'other@x.com', subject: '应聘' }), a.id])
    const c = r.claimAction(a.id)
    expect(c.ok).toBe(false)
    expect(c.ok === false && c.reason).toBe('content_changed')
    expect(r.getAction(a.id)!.status).toBe('pending_review')
  })

  it('updateActionPayload 让批准失效', () => {
    const r = mem()
    const a = r.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘' })
    r.reviewActions([a.id], 'approved')
    const b = r.updateActionPayload(a.id, { to: 'hr@x.com', subject: '应聘（改）' })
    expect(b.status).toBe('pending_review')
    expect(b.approved_hash).toBeNull()
    expect(b.content_hash).toBe(sha256(b.payload_json))
  })

  it('内容哈希与键顺序无关', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }))
  })

  it('不需要审核的动作 autoApprove 也带批准哈希，可以直接认领', () => {
    const r = mem()
    const a = r.enqueueAction('research', { company: 'X' }, null, true)
    expect(a.status).toBe('approved')
    expect(r.claimAction(a.id).ok).toBe(true)
    const s = r.enqueueAction('submit', { url: 'u' }, null, true)
    expect(s.status).toBe('pending_review')
  })
})

describe('投递材料包', () => {
  it('冻结简历快照与 JD；之后简历再改，材料包不变', () => {
    const r = mem()
    const j = r.upsertJob({ source_platform: 'campus', source_job_id: 'abc', title: '后端开发', company_name: '字节', jd_raw: '熟悉 Go' })
    const app = r.createApplication(j.id)
    const schema = JSON.stringify({ basics: { name: '{{vault:profile.name}}' }, work: [] })
    const p = r.createPacket({ application_id: app.id, job_id: j.id, resume_id: 'rm_1', resume_kind: 'master', resume_schema_json: schema, resume_pdf_path: '/x/packets/a.pdf', resume_pdf_sha256: 'deadbeef' })
    expect(p.resume_sha256).toBe(sha256(schema))
    expect(r.getApplication(app.id)!.packet_id).toBe(p.id)
    expect(JSON.parse(p.jd_snapshot_json).jd_raw).toBe('熟悉 Go')
    expect(p.job_key).toBe('campus:abc')
    r.db.update('job', j.id, { jd_raw: '改过的 JD' })
    expect(JSON.parse(r.getPacket(p.id)!.jd_snapshot_json).jd_raw).toBe('熟悉 Go')
    const snap = r.db.get<{ schema_json: string }>('SELECT schema_json FROM resume_snapshot WHERE id=?', [p.resume_snapshot_id!])!
    expect(snap.schema_json).toBe(schema)
  })

  it('动作引用材料包时记下 packet_id', () => {
    const r = mem()
    const p = r.createPacket({ resume_id: null })
    const a = r.enqueueAction('fill_form', { packet_id: p.id, job_id: 'j' })
    expect(a.packet_id).toBe(p.id)
  })
})

describe('稳定岗位键', () => {
  it('有原站岗位号 / 只有网址 / 都没有', () => {
    expect(jobKey({ source_platform: 'Boss', source_job_id: '123' })).toBe('boss:123')
    const a = jobKey({ source_platform: 'manual', url: 'https://www.jobs.bytedance.com/campus/position/7?utm_source=x&spm=1#top' })
    const b = jobKey({ source_platform: 'manual', url: 'https://jobs.bytedance.com/campus/position/7/' })
    expect(a).toBe(b)
    expect(a).toMatch(/^url:[0-9a-f]{16}$/)
    expect(jobKey({ source_platform: 'manual', company_name: ' 腾讯 ', title: '产品经理', location: '深圳' })).toBe(jobKey({ source_platform: 'x', company_name: '腾讯', title: '产品经理', location: '深圳' }))
  })

  it('同一网址的岗位重复导入只留一条', () => {
    const r = mem()
    const j1 = r.upsertJob({ source_platform: 'manual', title: '产品', url: 'https://a.com/job/1?utm_source=wx' })
    const j2 = r.upsertJob({ source_platform: 'manual', title: '产品经理', url: 'https://a.com/job/1' })
    expect(j2.id).toBe(j1.id)
    expect(r.getJobByKey(j1.job_key!)!.title).toBe('产品经理')
  })
})
