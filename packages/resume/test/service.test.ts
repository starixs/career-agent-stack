import { describe, it, expect } from 'vitest'
import { Db, Repos, FakeLLM } from '@career/core'
import { ResumeService, parseResume } from '../src/index.js'
import { sampleResume, sampleJd } from './fixture.js'

function svc() { const db = new Db(':memory:'); db.migrate(); return new ResumeService(new Repos(db)) }

describe('ResumeService', () => {
  it('master 创建 / 读取 / 更新（自动快照）/ 列表', () => {
    const s = svc()
    const m = s.createMaster({ name: '数据分析方向', direction: '数据分析', resume: sampleResume() })
    expect(m.id.startsWith('rsm_')).toBe(true)
    expect(s.getMaster(m.id).resume.basics.name).toBe('张三')
    const r2 = sampleResume(); r2.basics.city = '杭州'
    s.updateMaster(m.id, r2)
    expect(s.getMaster(m.id).resume.basics.city).toBe('杭州')
    expect(s.listSnapshots(m.id)).toHaveLength(1)
    expect(s.getSnapshotResume(s.listSnapshots(m.id)[0].id).basics.city).toBe('上海')
    expect(s.listMasters().map(x => x.id)).toEqual([m.id])
    expect(() => s.getMaster('rsm_nope')).toThrow('主简历不存在')
    expect(() => s.createMaster({ name: 'x', resume: { experience: 'bad' } as never })).toThrow('简历数据不合法')
  })

  it('tailored 派生 / 确认 diff（patch 或整份）/ 导出路径记录', () => {
    const s = svc()
    const m = s.createMaster({ name: '主简历', resume: sampleResume() })
    const job = s.repos.upsertJob({ source_platform: 'boss', source_job_id: 'j1', title: '数据分析实习生', company_name: '示例科技' })
    const t = s.deriveTailored(m.id, { jobId: job.id, strength: 'full' })
    expect(t.master_id).toBe(m.id)
    expect(t.strength).toBe('full')
    expect(t.diff_confirmed_at).toBeNull()
    expect(s.getTailored(t.id).resume).toEqual(sampleResume())
    const confirmed = s.confirmTailored(t.id, { patch: [{ op: 'replace', path: '/basics/objective', value: '数据分析实习生（示例科技）' }] })
    expect(confirmed.diff_confirmed_at).not.toBeNull()
    expect(s.getTailored(t.id).resume.basics.objective).toBe('数据分析实习生（示例科技）')
    expect(s.listSnapshots(t.id)).toHaveLength(1)
    s.recordExport(t.id, 'pdf', '/tmp/a.pdf'); s.recordExport(t.id, 'png', '/tmp/a.png')
    const row = s.getTailoredRow(t.id)!
    expect(row.export_pdf).toBe('/tmp/a.pdf'); expect(row.export_png).toBe('/tmp/a.png'); expect(row.export_docx).toBeNull()
    expect(s.listTailored({ jobId: job.id })).toHaveLength(1)
    expect(s.listTailored({ masterId: m.id })).toHaveLength(1)
    s.deleteMaster(m.id)
    expect(s.listTailored()).toHaveLength(0) // ON DELETE CASCADE
  })

  it('tailorAndStore：读 master + 岗位 JD + 经历库主张，只用已确认主张，落库为未确认', async () => {
    const s = svc()
    const m = s.createMaster({ name: '主简历', resume: sampleResume() })
    const exp = s.repos.createExperience({ title: '电商实习' })
    const ok = s.repos.addClaim({ experience_id: exp.id, text: '用 Tableau 做过 2 个仪表盘', status: 'user_confirmed' })
    s.repos.addClaim({ experience_id: exp.id, text: '独立负责 5000 万预算', status: 'pending' })
    const job = s.repos.upsertJob({ source_platform: 'boss', source_job_id: 'j2', title: '数据分析实习生', company_name: '示例科技', jd_parsed_json: JSON.stringify(sampleJd()) })
    const llm = new FakeLLM([JSON.stringify({ changes: [{ op: 'add', path: '/experience/0/bullets', value: '用 Tableau 做过 2 个仪表盘', claim_ids: [ok.id], reason: 'JD 加分项' }] })])
    const { tailored, result } = await s.tailorAndStore(llm, { masterId: m.id, jobId: job.id, strength: 'full' })
    expect(result.patch).toHaveLength(1)
    expect(result.excludedClaims).toBe(1)
    expect(llm.calls[0].messages[0].content).not.toContain('5000 万')
    expect(tailored.diff_confirmed_at).toBeNull()
    expect(s.getTailored(tailored.id).resume.experience[0].bullets).toHaveLength(4)
    expect(s.candidateText(m.id)).toContain('Tableau')
    expect(s.candidateText(m.id)).not.toContain('5000 万')
    await expect(s.tailorAndStore(llm, { masterId: m.id })).rejects.toThrow('需要提供 jd 或 jobId')
    expect(parseResume(JSON.parse(tailored.schema_json)).basics.name).toBe('张三')
  })
})
