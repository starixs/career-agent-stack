import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrations.js'

export type Row = Record<string, unknown>
export type Params = Record<string, SQLInputValue> | SQLInputValue[]

/** 轻量数据库封装：node:sqlite 同步 API，所有包共用一个连接。 */
export class Db {
  readonly raw: DatabaseSync
  constructor(public readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
  }
  migrate(): void {
    const here = dirname(fileURLToPath(import.meta.url))
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8')
    this.raw.exec(sql)
    const v = this.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
    if (!v.v) this.raw.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(now())
    runMigrations(this.raw)
  }
  run(sql: string, params: Params = []): { changes: number } {
    const st = this.raw.prepare(sql)
    const r = Array.isArray(params) ? st.run(...params) : st.run(params)
    return { changes: Number(r.changes) }
  }
  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const st = this.raw.prepare(sql)
    return (Array.isArray(params) ? st.get(...params) : st.get(params)) as T | undefined
  }
  all<T = Row>(sql: string, params: Params = []): T[] {
    const st = this.raw.prepare(sql)
    return (Array.isArray(params) ? st.all(...params) : st.all(params)) as T[]
  }
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try { const r = fn(); this.raw.exec('COMMIT'); return r } catch (e) { this.raw.exec('ROLLBACK'); throw e }
  }
  /** 通用插入：对象键即列名。 */
  insert(table: string, row: Record<string, unknown>): void {
    const keys = Object.keys(row)
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`
    this.run(sql, toParams(row))
  }
  /** 通用更新：按 id。自动写 updated_at（若表有该列由调用方传入）。 */
  update(table: string, id: string, patch: Record<string, unknown>): number {
    const keys = Object.keys(patch)
    if (keys.length === 0) return 0
    const sql = `UPDATE ${table} SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE id=@__id`
    return this.run(sql, { ...toParams(patch), __id: id }).changes
  }
  close(): void { this.raw.close() }
}

function toParams(row: Record<string, unknown>): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') out[k] = v
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (v instanceof Uint8Array) out[k] = v
    else out[k] = JSON.stringify(v)
  }
  return out
}

export function now(): string { return new Date().toISOString() }

export function openDb(path = defaultDbPath()): Db {
  const db = new Db(path)
  db.migrate()
  return db
}

export function defaultDbPath(): string {
  const dir = process.env.CAREER_DATA_DIR ?? join(process.cwd(), 'data')
  return join(dir, 'career.sqlite')
}
