import type { DatabaseSync } from 'node:sqlite'
import { jobKey } from '../keys.js'
import { classifyAnswerSensitivity } from '../answers.js'
import { inferEmploymentType, normalizeCohort } from '../jobs.js'

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
  {
    version: 3,
    name: 'answer-bank-governance',
    up(db) {
      // 答案库：固定 / 停用（保留历史）/ 删除；敏感度分级；来源；使用次数
      addColumn(db, 'answer_bank', 'status', "TEXT NOT NULL DEFAULT 'active'")
      addColumn(db, 'answer_bank', 'sensitivity', "TEXT NOT NULL DEFAULT 'normal'")
      addColumn(db, 'answer_bank', 'source', "TEXT NOT NULL DEFAULT 'user'")
      addColumn(db, 'answer_bank', 'use_count', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'answer_bank', 'last_used_at', 'TEXT')
      const rows = db.prepare('SELECT id, question_text FROM answer_bank').all() as Array<{ id: string; question_text: string }>
      const set = db.prepare('UPDATE answer_bank SET sensitivity=?, status=CASE WHEN ?=\'excluded\' THEN \'archived\' ELSE status END WHERE id=?')
      for (const r of rows) { const s = classifyAnswerSensitivity(r.question_text); set.run(s, s, r.id) }
      // 答案事件：答过 / 改过 / 页面上被纠正；uploaded_at 为空即待上传（服务端未配置时只在本地累积）
      db.exec(`CREATE TABLE IF NOT EXISTS answer_event (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        question_key TEXT NOT NULL,
        question_text TEXT NOT NULL,
        answer TEXT,
        previous_value TEXT,
        source TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        application_id TEXT,
        job_key TEXT,
        site_host TEXT,
        created_at TEXT NOT NULL,
        uploaded_at TEXT,
        upload_error TEXT
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_answer_event_upload ON answer_event(uploaded_at, created_at)')
    },
  },
  {
    version: 4,
    name: 'job-board',
    up(db) {
      // 岗位汇总表：校招 / 实习 / 社招、届别、服务端版本与下架状态、可解释匹配结果
      addColumn(db, 'job', 'employment_type', "TEXT NOT NULL DEFAULT 'unknown'")
      addColumn(db, 'job', 'cohort', 'TEXT')
      addColumn(db, 'job', 'source_version', 'INTEGER')
      addColumn(db, 'job', 'source_status', "TEXT NOT NULL DEFAULT 'open'")
      addColumn(db, 'job', 'match_json', 'TEXT')
      addColumn(db, 'job', 'match_score', 'REAL')
      db.exec('CREATE INDEX IF NOT EXISTS idx_job_board ON job(employment_type, deadline)')
      const rows = db.prepare('SELECT id, title, jd_raw, prefilter_json FROM job').all() as Array<{ id: string; title: string; jd_raw: string | null; prefilter_json: string | null }>
      const set = db.prepare('UPDATE job SET employment_type=?, cohort=COALESCE(cohort, ?) WHERE id=?')
      for (const r of rows) {
        let batch = ''; let cohort: string | null = null
        try { const p = JSON.parse(r.prefilter_json ?? '{}') as { campus?: { batch?: string; cohort?: string } }; batch = p.campus?.batch ?? ''; cohort = p.campus?.cohort ?? null } catch { /* ignore */ }
        set.run(inferEmploymentType(batch, r.title, (r.jd_raw ?? '').slice(0, 400)), normalizeCohort(cohort ?? r.jd_raw), r.id)
      }
    },
  },
  {
    version: 5,
    name: 'question-bank',
    up(db) {
      // 题库：面试题 / 笔试题 / 测评题的题目实体。来源：public 公共题库 / seen 我见过的（真实面试、笔试）/ generated 按 JD 出的
      db.exec(`CREATE TABLE IF NOT EXISTS question (
        id TEXT PRIMARY KEY,
        question_key TEXT NOT NULL UNIQUE,      -- 规范化题干（+ 公司）哈希：同一道题只存一条
        kind TEXT NOT NULL DEFAULT 'interview', -- interview|written|assessment
        category TEXT,                          -- 题型：opening|motivation|project|behavioral|case|… / 行测 / 编程…
        content TEXT NOT NULL,
        reference TEXT,                         -- 参考答案 / 考点（笔试）；面试题不给标准答案
        probe_points_json TEXT NOT NULL DEFAULT '[]',
        jd_requirement TEXT,
        company_name TEXT, title TEXT, job_id TEXT,
        source TEXT NOT NULL DEFAULT 'generated',
        sources_json TEXT NOT NULL DEFAULT '[]', -- 出现过的来源（interview:<id> / exam:<id> / generated:<job>）
        tags_json TEXT NOT NULL DEFAULT '[]',
        seen_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_score REAL,
        best_attempt_score REAL,
        first_seen_at TEXT, last_seen_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_question_company ON question(company_name, kind)')
      // 作答记录：绑定当时的简历版本与岗位，才能比较练习进步
      db.exec(`CREATE TABLE IF NOT EXISTS question_attempt (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'self',      -- self|mock|written|real
        answer_text TEXT,
        score REAL,                             -- 0–100
        feedback_json TEXT NOT NULL DEFAULT '{}',
        resume_id TEXT, resume_snapshot_id TEXT, job_id TEXT,
        mock_interview_id TEXT, exam_id TEXT, interview_id TEXT,
        created_at TEXT NOT NULL
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_attempt_question ON question_attempt(question_id, created_at)')
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
