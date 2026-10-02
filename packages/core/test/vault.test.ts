import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db, Vault, StaticKeyProvider, FileKeyProvider, maskValue, vaultPlaceholder, parseVaultPlaceholder, normalizeHost, PROFILE_FIELDS } from '../src/index.js'

const KEY = Buffer.alloc(32, 7)
function mem() { const db = new Db(':memory:'); db.migrate(); return { db, vault: new Vault(db, new StaticKeyProvider(KEY)) } }
const ui = { actor: 'ui' as const }

describe('私密库：加密存储', () => {
  it('写入后库里只有密文，reveal 能解回明文并记访问日志', () => {
    const { db, vault } = mem()
    const meta = vault.set({ scope: 'profile', field: 'phone', value: '13800138000' })!
    expect(meta.preview).toBe('138****8000')
    expect(meta.sensitive).toBe(true)
    const row = db.get<{ ciphertext: Uint8Array }>('SELECT ciphertext FROM vault_item WHERE id=?', [meta.id])!
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('13800138000')
    expect(JSON.stringify(vault.list())).not.toContain('13800138000')
    expect(vault.reveal(meta.id, { actor: 'form_fill', purpose: '测试' })).toBe('13800138000')
    expect(vault.accessLog()[0]).toMatchObject({ item_id: meta.id, actor: 'form_fill' })
  })
  it('换一把密钥解不开（密文与密钥、作用域绑定）', () => {
    const { db, vault } = mem()
    vault.set({ scope: 'profile', field: 'email', value: 'a@b.com' })
    const other = new Vault(db, new StaticKeyProvider(Buffer.alloc(32, 9)))
    expect(() => other.reveal({ scope: 'profile', field: 'email' }, ui)).toThrow()
  })
  it('空值等于删除；覆盖写保留 label 与策略', () => {
    const { vault } = mem()
    const a = vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: 'p1', label: '智联', policy: { autofill: true } })!
    expect(a.preview).toBe('')
    const b = vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: 'p2' })!
    expect(b.id).toBe(a.id); expect(b.label).toBe('智联'); expect(b.policy.autofill).toBe(true)
    expect(vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: '  ' })).toBeUndefined()
    expect(vault.list('site')).toEqual([])
  })
  it('非 profile 作用域必须带 ref_id', () => {
    const { vault } = mem()
    expect(() => vault.set({ scope: 'experience', field: 'org', value: 'X' })).toThrow()
  })
  it('FileKeyProvider 首次生成 0600 的密钥文件，再次读取一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'))
    const p = new FileKeyProvider(join(dir, 'sub', 'vault.key'))
    const k1 = p.getKey()
    expect(k1.length).toBe(32)
    expect(statSync(join(dir, 'sub', 'vault.key')).mode & 0o777).toBe(0o600)
    expect(new FileKeyProvider(join(dir, 'sub', 'vault.key')).getKey().equals(k1)).toBe(true)
    expect(readFileSync(join(dir, 'sub', 'vault.key'), 'utf8').trim()).toHaveLength(64)
  })
})

describe('私密库：占位符与脱敏', () => {
  it('占位符格式往返', () => {
    expect(vaultPlaceholder('profile', '', 'phone')).toBe('{{vault:profile.phone}}')
    expect(vaultPlaceholder('experience', 'exp_abc', 'org')).toBe('{{vault:exp.exp_abc.org}}')
    expect(parseVaultPlaceholder('{{vault:exp.exp_abc.client_name}}')).toEqual({ scope: 'experience', ref_id: 'exp_abc', field: 'client_name' })
    expect(parseVaultPlaceholder('{{vault:site.campus.zhaopin.com.username}}')).toEqual({ scope: 'site', ref_id: 'campus.zhaopin.com', field: 'username' })
    expect(parseVaultPlaceholder('{{vault:profile.name}}')).toEqual({ scope: 'profile', ref_id: '', field: 'name' })
  })
  it('resolve 把占位符换成明文，缺项保留并由 unresolved 列出', () => {
    const { vault } = mem()
    vault.set({ scope: 'profile', field: 'name', value: '张三' })
    vault.set({ scope: 'experience', ref_id: 'exp_1', field: 'org', value: '某保密公司' })
    const text = '我是{{vault:profile.name}}，在{{vault:exp.exp_1.org}}实习，电话{{vault:profile.phone}}'
    expect(vault.resolve(text, { actor: 'resume_export' })).toBe('我是张三，在某保密公司实习，电话{{vault:profile.phone}}')
    expect(vault.unresolved(text)).toEqual(['{{vault:profile.phone}}'])
    expect(vault.resolveDeep({ a: ['{{vault:profile.name}}'], b: { c: 1 } }, ui)).toEqual({ a: ['张三'], b: { c: 1 } })
  })
  it('redact 把明文换回占位符；非敏感字段不处理；长值优先', () => {
    const { vault } = mem()
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' })
    vault.set({ scope: 'profile', field: 'name', value: '张三' })
    vault.set({ scope: 'profile', field: 'school', value: '某某大学' })
    vault.set({ scope: 'profile', field: 'emergencyContact', value: '张三丰 13800138000' })
    const out = vault.redactDeep({ filled: [{ label: '姓名', value: '张三' }, { label: '手机', value: '13800138000' }, { label: '学校', value: '某某大学' }], note: '紧急联系人 张三丰 13800138000' })
    expect(out.filled[0].value).toBe('{{vault:profile.name}}')
    expect(out.filled[1].value).toBe('{{vault:profile.phone}}')
    expect(out.filled[2].value).toBe('某某大学')
    expect(out.note).toBe('紧急联系人 {{vault:profile.emergencyContact}}')
  })
  it('redact 的误伤保护：短 ASCII 值不处理，ASCII 值按词边界匹配', () => {
    const { vault } = mem()
    vault.set({ scope: 'site', ref_id: 'x.com', field: 'username', value: 'tom' })
    vault.set({ scope: 'site', ref_id: 'x.com', field: 'password', value: 'pass1234' })
    vault.set({ scope: 'profile', field: 'email', value: 'tom@x.com' })
    expect(vault.redact('username tomorrow tom pass1234 pass12345 tom@x.com')).toBe('username tomorrow tom {{vault:site.x.com.password}} pass12345 {{vault:profile.email}}')
  })
  it('status 只给字段名 / 标签 / 预览 / 占位符', () => {
    const { vault } = mem()
    vault.set({ scope: 'profile', field: 'email', value: 'zhangsan@example.com' })
    vault.set({ scope: 'site', ref_id: 'nowcoder.com', field: 'username', value: 'u', label: '牛客', policy: { autofill: true } })
    vault.set({ scope: 'site', ref_id: 'nowcoder.com', field: 'password', value: 'secret-pass' })
    vault.set({ scope: 'experience', ref_id: 'exp_9', field: 'client', value: '保密客户', label: '客户名' })
    const s = vault.status()
    expect(s.profile.filled).toEqual([{ field: 'email', label: '邮箱', preview: 'z***@example.com', sensitive: true }])
    expect(s.profile.missing.length).toBe(PROFILE_FIELDS.length - 1)
    expect(s.sites).toEqual([{ host: 'nowcoder.com', label: '牛客', hasUsername: true, hasPassword: true, autofill: true }])
    expect(s.experiences).toEqual([{ experience_id: 'exp_9', fields: [{ field: 'client', label: '客户名', placeholder: '{{vault:exp.exp_9.client}}' }] }])
    expect(JSON.stringify(s)).not.toMatch(/secret-pass|保密客户|zhangsan@/)
  })
  it('credential 按 host 后缀匹配，profileSafeBasics 只含非敏感字段', () => {
    const { vault } = mem()
    vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'username', value: 'me' })
    vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: 'pw' })
    expect(vault.credential('https://xiaoyuan.zhaopin.com/login', { actor: 'login_fill' })).toMatchObject({ host: 'zhaopin.com', username: 'me', password: 'pw', autofill: false })
    expect(vault.credential('https://boss.com', { actor: 'login_fill' })).toBeUndefined()
    vault.set({ scope: 'profile', field: 'name', value: '张三' }); vault.set({ scope: 'profile', field: 'school', value: 'X 大学' })
    expect(vault.profileSafeBasics()).toEqual({ school: 'X 大学' })
    expect(vault.profileBasics({ actor: 'form_fill' })).toEqual({ name: '张三', school: 'X 大学' })
  })
  it('maskValue / normalizeHost', () => {
    expect(maskValue('idNumber', '110101200001011234')).toMatch(/^110\*+34$/)
    expect(maskValue('name', '欧阳修')).toBe('欧**')
    expect(maskValue('password', 'x')).toBe('')
    expect(normalizeHost('https://www.Zhaopin.com/jobs?x=1')).toBe('zhaopin.com')
    expect(normalizeHost('campus.51job.com')).toBe('campus.51job.com')
  })
})
