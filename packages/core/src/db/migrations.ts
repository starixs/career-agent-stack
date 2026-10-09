import type { DatabaseSync } from 'node:sqlite'
import { jobKey } from '../keys.js'

/**
 * 增量迁移。schema.sql 是版本 1 的基线（新库整份建出来，老库靠 IF NOT EXISTS 补新表）；
 * 之后对已有表的任何结构变化（加列、加索引、回填）都只能写在这里，按 version 递增、只跑一次。
 *
 * 规则：
 *  - 只追加，不修改已发布的条目；version 必须连续递增。
 *  - up 在 `BEGIN IMMEDIATE` 事务里执行（Global 与 Session 两个侧车可能同时打开库，靠写锁串行），
 *    事务内重新读当前版本，避免两边各跑一遍。
 *  - 加列用 addColumn（列已存在时跳过），这样手工修过的库也能迁过去。
 */
export interface Migration { version: number; name: string; up(db: DatabaseSync): void }

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column)
}
export function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: 'apply-consistency',
    up(db) {
      // 审批绑定内容：批准时记下当时 payload 的哈希，执行前比对；谁批准的（user / auto / learned）。
      addColumn(db, 'action_queue', 'content_hash', 'TEXT')
      addColumn(db, 'action_queue', 'approved_hash', 'TEXT')
      addColumn(db, 'action_queue', 'approved_by', 'TEXT')
      addColumn(db, 'action_queue', 'packet_id', 'TEXT')
      // 稳定岗位键：站点 + 原站岗位号（没有就按规范化网址 / 公司职位地点哈希），本地与服务端岗位库共用。
      addColumn(db, 'job', 'job_key', 'TEXT')
      addColumn(db, 'job', 'remote_id', 'TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS idx_job_key ON job(job_key)')
      const jobs = db.prepare('SELECT id, source_platform, source_job_id, url, company_name, title, location FROM job WHERE job_key IS NULL').all() as Array<Record<string, string | null>>
      const setKey = db.prepare('UPDATE job SET job_key=? WHERE id=?')
      for (const j of jobs) setKey.run(jobKey(j), j.id as string)
      // 投递材料包：批准时冻结的简历快照 + 文件 + JD 原文；投递记录永远能找回当时用的那一份。
      db.exec(`CREATE TABLE IF NOT EXISTS application_packet (
        id TEXT PRIMARY KEY,
        application_id TEXT REFERENCES application(id) ON DELETE SET NULL,
        job_id TEXT,
        job_key TEXT,
        resume_id TEXT,
        resume_kind TEXT,
        resume_snapshot_id TEXT,
        resume_sha256 TEXT,
        resume_pdf_path TEXT,
        resume_pdf_sha256 TEXT,
        jd_snapshot_json TEXT NOT NULL DEFAULT '{}',
        answers_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_packet_application ON application_packet(application_id, created_at)')
      addColumn(db, 'application', 'packet_id', 'TEXT')
    },
  },
]

export function currentVersion(db: DatabaseSync): number {
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return v.v ?? 0
}

/** 跑所有未应用的迁移；返回应用了的版本号。 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => string = () => new Date().toISOString()): number[] {
  const applied: number[] = []
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (currentVersion(db) >= m.version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      if (currentVersion(db) < m.version) {
        m.up(db)
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, now())
        applied.push(m.version)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`数据库迁移 v${m.version}（${m.name}）失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return applied
}
