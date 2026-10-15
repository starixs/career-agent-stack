import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Db, Repos, canReachStage, normalizeBoardMeta, parseBoardJson, serializeBoardMeta, batchFromText, boardMetaFromJd } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('汇总表维度 board_json', () => {
  it('企业性质从行业挪到类型标签；「其他」与空值不算；全空不写', () => {
    expect(normalizeBoardMeta({ batch: '正式批', industry: '央国企' })).toEqual({ batch: '正式批', industry: null, type_tags: ['央国企'] })
    expect(normalizeBoardMeta({ batch: '其他', industry: ' 互联网 ', type_tags: ['外企', '', 3] })).toEqual({ batch: null, industry: '互联网', type_tags: ['外企'] })
    expect(serializeBoardMeta({ batch: null, industry: '其他' })).toBeUndefined()
    expect(parseBoardJson('坏 JSON')).toBeNull()
  })

  it('批次只认原文里字面出现的词；JD 解析只用显式字段和 notes 里的企业性质词', () => {
    expect(batchFromText('2027届秋招提前批开启')).toBe('提前批')
    expect(batchFromText('负责数据分析')).toBeNull()
    expect(normalizeBoardMeta(boardMetaFromJd({ notes: ['公司性质：国企，读者是业务方'] }, '2027届春招'))).toEqual({ batch: '春招', industry: null, type_tags: ['国企'] })
    expect(normalizeBoardMeta(boardMetaFromJd({ industry: '半导体', notes: [] }))).toEqual({ batch: null, industry: '半导体', type_tags: [] })
  })

  it('upsertJob 写 board_json；同一岗位再次导入按字段合并，不给的字段不抹掉', () => {
    const r = mem()
    const a = r.upsertJob({ source_platform: 'campus', source_job_id: 'c1', title: '研发', company_name: '甲', board_json: serializeBoardMeta({ batch: '正式批', industry: '央国企' }) })
    expect(parseBoardJson(a.board_json)).toEqual({ batch: '正式批', industry: null, type_tags: ['央国企'] })
    r.upsertJob({ source_platform: 'campus', source_job_id: 'c1', title: '研发', company_name: '甲', board_json: serializeBoardMeta({ industry: '制造业' }) })
    const b = r.upsertJob({ source_platform: 'campus', source_job_id: 'c1', title: '研发', company_name: '甲', prefilter_json: '{"pass":true}' })
    expect(parseBoardJson(b.board_json)).toEqual({ batch: '正式批', industry: '制造业', type_tags: ['央国企'] })
  })

  it('迁移 v7：老库从 prefilter_json.campus 回填 board_json；deadline.due_at 改为可空且数据不丢', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'career-v7-')), 'old.sqlite')
    const db0 = new Db(path); db0.migrate()
    // 回到 v6 的样子：没有 board_json 列、due_at NOT NULL
    db0.raw.exec(`DELETE FROM schema_migrations WHERE version >= 7; ALTER TABLE job DROP COLUMN board_json; DROP TABLE deadline;
      CREATE TABLE deadline (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, due_at TEXT NOT NULL, application_id TEXT REFERENCES application(id) ON DELETE CASCADE, job_id TEXT, interview_id TEXT, offer_id TEXT, source TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'open', url TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO job (id, source_platform, title, prefilter_json, created_at, updated_at) VALUES ('job_old', 'campus', '研发', '{"campus":{"batch":"提前批","industry":"互联网"}}', 'a', 'a');
      INSERT INTO deadline (id, kind, title, due_at, created_at, updated_at) VALUES ('ddl_old', 'written_test', '笔试', '2026-10-20T06:00:00.000Z', 'a', 'a');`)
    db0.close()
    const raw = new DatabaseSync(path)
    expect((raw.prepare('PRAGMA table_info(deadline)').all() as Array<{ name: string; notnull: number }>).find(c => c.name === 'due_at')!.notnull).toBe(1)
    raw.close()
    const db = new Db(path); db.migrate()
    const r = new Repos(db)
    expect(parseBoardJson(r.getJob('job_old')!.board_json)).toEqual({ batch: '提前批', industry: '互联网', type_tags: [] })
    expect(r.getDeadline('ddl_old')!.due_at).toBe('2026-10-20T06:00:00.000Z')
    const unknown = r.createDeadline({ kind: 'written_test', title: '笔试（时间未知）', due_at: null })
    expect(r.getDeadline(unknown.id)!.due_at).toBeNull()
    db.close()
  })
})

describe('时间未知的截止事件', () => {
  it('可以建；排在有时间的后面；不会被标成过期；今日队列提示去确认时间', () => {
    const r = mem()
    const u = r.createDeadline({ kind: 'written_test', title: '甲 笔试', due_at: null })
    const k = r.createDeadline({ kind: 'assessment', title: '乙 测评', due_at: '2026-10-17T06:00:00.000Z' })
    expect(r.listDeadlines({ status: 'open' }).map(d => d.id)).toEqual([k.id, u.id])
    expect(r.markMissedDeadlines('2026-12-01T00:00:00.000Z')).toBe(1)
    expect(r.getDeadline(u.id)!.status).toBe('open')
    const items = r.today('2026-12-01T00:00:00.000Z').items
    expect(items.find(i => i.deadline_id === u.id)).toMatchObject({ kind: 'deadline', due_at: null, detail: expect.stringContaining('时间未知') })
  })
})

describe('只往前推进 advanceTo', () => {
  it('目标在前方才推进；已在更后的阶段 / 已关闭时原样返回、不抛错', () => {
    expect(canReachStage('evaluated', 'applied')).toBe(true)
    expect(canReachStage('interview', 'applied')).toBe(false)
    expect(canReachStage('applied', 'applied')).toBe(false)
    const r = mem()
    const j = r.upsertJob({ source_platform: 'manual', title: '研发', company_name: '甲' })
    const a = r.createApplication(j.id)
    expect(r.advanceTo(a.id, 'interview', '面试邀请')).toMatchObject({ moved: true, app: { stage: 'interview' } })
    const again = r.advanceTo(a.id, 'applied', '笔试通知')
    expect(again).toMatchObject({ moved: false, app: { stage: 'interview' } })
    r.jumpTo(a.id, 'rejected')
    expect(r.advanceTo(a.id, 'applied').moved).toBe(false)
  })
})
