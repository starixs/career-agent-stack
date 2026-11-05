import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db, Repos, applyChannelOf, currentVersion, emailDomain, extractApplyEmail, extractMailFormat, hasColumn, isEmailAddress } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('extractApplyEmail：只认投递语境里的邮箱', () => {
  it('「简历投递至 hr@abc.com」', () => {
    expect(extractApplyEmail('有意者请将简历投递至 hr@abc.com')?.email).toBe('hr@abc.com')
  })
  it('全角冒号、后面跟着邮件标题格式', () => {
    const hit = extractApplyEmail('请将简历发送到：campus@x.cn，邮件标题：姓名-学校-岗位')
    expect(hit?.email).toBe('campus@x.cn')
    expect(hit!.evidence.length).toBeLessThanOrEqual(60)
    expect(hit!.evidence).toContain('campus@x.cn')
  })
  it('商务合作的邮箱不认', () => {
    expect(extractApplyEmail('商务合作 bd@x.com')).toBeNull()
  })
  it('页脚只有「联系我们」不认', () => {
    expect(extractApplyEmail('岗位职责：负责数据分析。\n\n联系我们 contact@x.com')).toBeNull()
  })
  it('中英混排', () => {
    expect(extractApplyEmail('Please send your CV to talent@foo.io before Dec 1.')?.email).toBe('talent@foo.io')
    expect(extractApplyEmail('欢迎投递 resume，邮箱 Jobs@Bar.com')?.email).toBe('Jobs@Bar.com')
  })
  it('邮箱后紧跟句号：句号不算进邮箱', () => {
    expect(extractApplyEmail('简历请发至 hr@abc.com.')?.email).toBe('hr@abc.com')
    expect(extractApplyEmail('简历请发至hr@abc.com。谢谢')?.email).toBe('hr@abc.com')
  })
  it('投递邮箱与合作邮箱挨着：各看各的前文', () => {
    expect(extractApplyEmail('简历投递：hr@a.com；商务合作：bd@a.com')?.email).toBe('hr@a.com')
    expect(extractApplyEmail('商务合作：bd@a.com；简历投递：hr@a.com')?.email).toBe('hr@a.com')
  })
  it('noreply 不认；没有邮箱为 null', () => {
    expect(extractApplyEmail('简历发送至 noreply@x.com')).toBeNull()
    expect(extractApplyEmail('简历投递见官网')).toBeNull()
  })
})

describe('extractMailFormat：抽得到才给，不猜', () => {
  it('标题与附件命名', () => {
    expect(extractMailFormat('邮件标题：姓名-学校-岗位-每周天数。附件命名：姓名-学校.pdf；')).toEqual({ subject_format: '姓名-学校-岗位-每周天数', attachment_format: '姓名-学校.pdf' })
  })
  it('只写了标题格式', () => {
    expect(extractMailFormat('邮件主题请注明“应聘岗位+姓名”')).toEqual({ subject_format: '应聘岗位+姓名' })
  })
  it('没写返回空对象', () => {
    expect(extractMailFormat('岗位职责：写代码')).toEqual({})
  })
})

describe('applyChannelOf 与收件人工具', () => {
  it('有投递邮箱走邮件（即使也有链接），只有链接走网申，都没有为 null', () => {
    expect(applyChannelOf({ url: 'https://a.com', apply_email: 'hr@a.com' })).toBe('mail')
    expect(applyChannelOf({ url: 'https://a.com', apply_email: null })).toBe('web')
    expect(applyChannelOf({ url: null, apply_email: '  ' })).toBeNull()
  })
  it('isEmailAddress / emailDomain', () => {
    expect(isEmailAddress('hr@abc.com')).toBe(true)
    expect(isEmailAddress('hr@abc')).toBe(false)
    expect(isEmailAddress('a@b.com, c@d.com')).toBe(false)
    expect(emailDomain('HR@Abc.Com')).toBe('abc.com')
  })
})

describe('入库时认投递邮箱（upsertJob）', () => {
  it('新建：JD 里写了就填上；来源给了以来源为准', () => {
    const r = mem()
    const a = r.upsertJob({ source_platform: 'manual', title: '产品实习生', company_name: '甲', jd_raw: '简历投递至 hr@jia.com' })
    expect(a.apply_email).toBe('hr@jia.com')
    const b = r.upsertJob({ source_platform: 'manual', title: '运营实习生', company_name: '乙', jd_raw: '简历投递至 hr@yi.com', apply_email: 'campus@yi.com' })
    expect(b.apply_email).toBe('campus@yi.com')
    const c = r.upsertJob({ source_platform: 'manual', title: '后端', company_name: '丙', url: 'https://c.com' })
    expect(c.apply_email).toBeNull()
  })
  it('更新 JD：库里为空时认一次；库里已有不覆盖', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'manual', source_job_id: '1', title: '产品实习生', company_name: '甲' })
    expect(r.upsertJob({ source_platform: 'manual', source_job_id: '1', title: '产品实习生', jd_raw: '简历请发送至 a@jia.com' }).apply_email).toBe('a@jia.com')
    expect(r.upsertJob({ source_platform: 'manual', source_job_id: '1', title: '产品实习生', jd_raw: '简历请发送至 b@jia.com' }).apply_email).toBe('a@jia.com')
    expect(r.getJob(job.id)!.apply_email).toBe('a@jia.com')
  })
})

describe('迁移 v10：老库补 job.apply_email', () => {
  it('v9 的库打开后有这一列，原有岗位不丢', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'career-mig10-')), 'old.sqlite')
    const db0 = new Db(path); db0.migrate()
    db0.raw.exec(`DELETE FROM schema_migrations WHERE version >= 10; ALTER TABLE job DROP COLUMN apply_email;`)
    db0.raw.exec(`INSERT INTO job(id, source_platform, title, created_at, updated_at) VALUES ('job_old', 'manual', '老岗位', 'a', 'a')`)
    expect(hasColumn(db0.raw, 'job', 'apply_email')).toBe(false)
    db0.close()
    const db = new Db(path); db.migrate()
    expect(currentVersion(db.raw)).toBeGreaterThanOrEqual(10)
    expect(hasColumn(db.raw, 'job', 'apply_email')).toBe(true)
    expect(db.get<{ title: string; apply_email: string | null }>('SELECT title, apply_email FROM job WHERE id=?', ['job_old'])).toEqual({ title: '老岗位', apply_email: null })
    db.close()
  })
})
