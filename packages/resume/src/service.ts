/**
 * ResumeService：封装 resume_master / resume_tailored / resume_snapshot 的读写。
 * 规则：tailored 先以"未确认"落库，用户确认 diff 后才写 diff_confirmed_at；每次覆盖前自动存快照。
 */
import { now, newId, type Repos, type LLM, type ResumeMaster, type ResumeTailored, type JdParsed } from '@career/core'
import jsonpatch from 'fast-json-patch'
import type { Operation } from 'fast-json-patch'
import { parseResume, resumeText, type Resume } from './schema.js'
import { tailorResume, type TailorStrength, type TailorResult } from './tailor.js'

const { applyPatch, deepClone } = jsonpatch

export interface ResumeSnapshot { id: string; resume_id: string; schema_json: string; note: string | null; created_at: string }
export type ExportKind = 'pdf' | 'docx' | 'png'
export interface TailorAndStoreResult { tailored: ResumeTailored; result: TailorResult }

export class ResumeService {
  constructor(public readonly repos: Repos) {}
  private get db() { return this.repos.db }

  // ---------- master ----------
  createMaster(input: { name: string; direction?: string | null; resume?: Resume }): ResumeMaster {
    const resume = parseResume(input.resume ?? {})
    const t = now(); const id = newId('rsm')
    this.db.insert('resume_master', { id, name: input.name, direction: input.direction ?? null, schema_json: JSON.stringify(resume), created_at: t, updated_at: t })
    return this.getMasterRow(id)!
  }
  getMasterRow(id: string): ResumeMaster | undefined { return this.db.get<ResumeMaster>('SELECT * FROM resume_master WHERE id=?', [id]) }
  getMaster(id: string): { row: ResumeMaster; resume: Resume } {
    const row = this.getMasterRow(id)
    if (!row) throw new Error(`主简历不存在：${id}`)
    return { row, resume: parseResume(JSON.parse(row.schema_json)) }
  }
  listMasters(): ResumeMaster[] { return this.db.all<ResumeMaster>('SELECT * FROM resume_master ORDER BY updated_at DESC') }
  /** 覆盖主简历内容；旧版本自动存快照。 */
  updateMaster(id: string, resume: Resume, note = '更新前快照'): ResumeMaster {
    const cur = this.getMaster(id)
    const next = parseResume(resume)
    this.db.transaction(() => {
      this.snapshot(id, cur.resume, note)
      this.db.update('resume_master', id, { schema_json: JSON.stringify(next), updated_at: now() })
    })
    return this.getMasterRow(id)!
  }
  deleteMaster(id: string): void { this.db.run('DELETE FROM resume_master WHERE id=?', [id]) }

  // ---------- tailored ----------
  /** 从 master 派生定制版；resume 缺省为 master 的拷贝（未确认）。 */
  deriveTailored(masterId: string, input: { jobId?: string | null; strength?: TailorStrength; resume?: Resume } = {}): ResumeTailored {
    const m = this.getMaster(masterId)
    const resume = parseResume(input.resume ?? deepClone(m.resume))
    const t = now(); const id = newId('rst')
    this.db.insert('resume_tailored', { id, master_id: masterId, job_id: input.jobId ?? null, schema_json: JSON.stringify(resume), strength: input.strength ?? 'keywords', diff_confirmed_at: null, export_pdf: null, export_docx: null, export_png: null, created_at: t, updated_at: t })
    return this.getTailoredRow(id)!
  }
  getTailoredRow(id: string): ResumeTailored | undefined { return this.db.get<ResumeTailored>('SELECT * FROM resume_tailored WHERE id=?', [id]) }
  getTailored(id: string): { row: ResumeTailored; resume: Resume } {
    const row = this.getTailoredRow(id)
    if (!row) throw new Error(`定制简历不存在：${id}`)
    return { row, resume: parseResume(JSON.parse(row.schema_json)) }
  }
  listTailored(filter: { masterId?: string; jobId?: string } = {}): ResumeTailored[] {
    if (filter.masterId) return this.db.all<ResumeTailored>('SELECT * FROM resume_tailored WHERE master_id=? ORDER BY updated_at DESC', [filter.masterId])
    if (filter.jobId) return this.db.all<ResumeTailored>('SELECT * FROM resume_tailored WHERE job_id=? ORDER BY updated_at DESC', [filter.jobId])
    return this.db.all<ResumeTailored>('SELECT * FROM resume_tailored ORDER BY updated_at DESC')
  }
  /**
   * 用户确认 diff 后落库：可传整份 resume，或传要在当前存储版本上应用的 JSON Patch。
   * 旧版本存快照，写 diff_confirmed_at。
   */
  confirmTailored(id: string, input: { resume?: Resume; patch?: Operation[]; note?: string } = {}): ResumeTailored {
    const cur = this.getTailored(id)
    let next: Resume = cur.resume
    if (input.resume) next = parseResume(input.resume)
    else if (input.patch?.length) next = parseResume(applyPatch(deepClone(cur.resume), input.patch, true, false).newDocument)
    this.db.transaction(() => {
      this.snapshot(id, cur.resume, input.note ?? '确认前快照')
      this.db.update('resume_tailored', id, { schema_json: JSON.stringify(next), diff_confirmed_at: now(), updated_at: now() })
    })
    return this.getTailoredRow(id)!
  }
  /** 记录导出文件路径。 */
  recordExport(id: string, kind: ExportKind, path: string): ResumeTailored {
    if (!this.getTailoredRow(id)) throw new Error(`定制简历不存在：${id}`)
    this.db.update('resume_tailored', id, { [`export_${kind}`]: path, updated_at: now() })
    return this.getTailoredRow(id)!
  }
  deleteTailored(id: string): void { this.db.run('DELETE FROM resume_tailored WHERE id=?', [id]) }

  // ---------- snapshot ----------
  snapshot(resumeId: string, resume: Resume, note?: string): ResumeSnapshot {
    const id = newId('rss')
    this.db.insert('resume_snapshot', { id, resume_id: resumeId, schema_json: JSON.stringify(parseResume(resume)), note: note ?? null, created_at: now() })
    return this.db.get<ResumeSnapshot>('SELECT * FROM resume_snapshot WHERE id=?', [id])!
  }
  listSnapshots(resumeId: string): ResumeSnapshot[] { return this.db.all<ResumeSnapshot>('SELECT * FROM resume_snapshot WHERE resume_id=? ORDER BY created_at DESC', [resumeId]) }
  getSnapshotResume(snapshotId: string): Resume {
    const s = this.db.get<ResumeSnapshot>('SELECT * FROM resume_snapshot WHERE id=?', [snapshotId])
    if (!s) throw new Error(`快照不存在：${snapshotId}`)
    return parseResume(JSON.parse(s.schema_json))
  }

  // ---------- 组合流程 ----------
  /**
   * 读 master + 岗位 jd_parsed_json + 经历库主张 → 调模型定制 → 以"未确认"状态落库。
   * 返回的 result.patch / rationale / truthfulnessFlags 交给 UI 展示，用户确认后调 confirmTailored。
   */
  async tailorAndStore(llm: LLM, input: { masterId: string; jobId?: string | null; jd?: JdParsed; strength?: TailorStrength; rejectFlagged?: boolean }): Promise<TailorAndStoreResult> {
    const m = this.getMaster(input.masterId)
    let jd = input.jd
    if (!jd && input.jobId) {
      const job = this.repos.getJob(input.jobId)
      if (!job) throw new Error(`岗位不存在：${input.jobId}`)
      if (!job.jd_parsed_json) throw new Error('岗位还没有解析过 JD（jd_parsed_json 为空），请先调用 parseJd')
      jd = JSON.parse(job.jd_parsed_json) as JdParsed
    }
    if (!jd) throw new Error('需要提供 jd 或 jobId')
    const claims = this.repos.listClaims()
    const result = await tailorResume(llm, { master: m.resume, jd, claims, strength: input.strength, rejectFlagged: input.rejectFlagged })
    const tailored = this.deriveTailored(input.masterId, { jobId: input.jobId ?? null, strength: input.strength ?? 'keywords', resume: result.proposed })
    return { tailored, result }
  }

  /** 候选人材料文本（简历 + 已确认主张），给 parseJd 做关键词三分类用。 */
  candidateText(masterId: string): string {
    const m = this.getMaster(masterId)
    const claims = this.repos.listClaims().filter(c => c.status !== 'pending')
    return [resumeText(m.resume), ...claims.map(c => `- ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`)].join('\n')
  }
}
