import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { Db, now } from './db/db.js'
import { newId } from './ids.js'

/**
 * 私密信息库（Vault）：本人基本信息（姓名 / 手机 / 邮箱 / 身份证…）、投递网站账号密码、经历的保密补充。
 *
 * 设计原则（与第三方"密钥不进上下文"的做法一致）：
 *  1. 值一律 AES-256-GCM 加密落库，密钥在 SQLite 之外（文件 0600 或环境变量），拿到数据库文件也读不出值。
 *  2. 模型侧永远拿不到明文：工具层只能调用 status()/list()（字段名 + 脱敏预览），
 *     文本里用占位符 {{vault:profile.phone}} / {{vault:exp.<经历id>.<字段>}} 指代；
 *     真正需要明文的地方（填表、登录、导出简历）在 Node 侧通过 resolve()/reveal() 解密，并写访问日志。
 *  3. redact()：把工具结果 / 页面抓取里出现的明文替换回占位符，作为最后一道防线。
 */

export type VaultScope = 'profile' | 'site' | 'experience'
export type VaultActor = 'ui' | 'form_fill' | 'login_fill' | 'resume_export' | 'resolve' | 'test'
export interface VaultAccess { actor: VaultActor; purpose?: string }
export interface VaultPolicy { autofill?: boolean }

export interface VaultItemMeta {
  id: string
  scope: VaultScope
  ref_id: string
  field: string
  label: string | null
  preview: string | null
  sensitive: boolean
  policy: VaultPolicy
  created_at: string
  updated_at: string
}
export interface VaultSetInput { scope: VaultScope; ref_id?: string; field: string; value: string; label?: string | null; sensitive?: boolean; policy?: VaultPolicy }

interface VaultRow { id: string; scope: VaultScope; ref_id: string; field: string; label: string | null; ciphertext: Uint8Array; preview: string | null; sensitive: number; policy_json: string; created_at: string; updated_at: string }

// ---------- 密钥来源 ----------
export interface KeyProvider { getKey(): Buffer }

/** 密钥文件（32 字节随机，0600）。缺省放在 CAREER_DATA_DIR/vault.key，与 SQLite 分开保存。 */
export class FileKeyProvider implements KeyProvider {
  private cached?: Buffer
  constructor(public readonly path: string) {}
  getKey(): Buffer {
    if (this.cached) return this.cached
    if (existsSync(this.path)) {
      const raw = readFileSync(this.path, 'utf8').trim()
      const key = Buffer.from(raw, 'hex')
      if (key.length !== 32) throw new Error(`私密库密钥文件损坏：${this.path}`)
      this.cached = key
      return key
    }
    const key = randomBytes(32)
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, key.toString('hex') + '\n', { mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch { /* Windows 无 POSIX 权限 */ }
    this.cached = key
    return key
  }
}
/** 固定密钥（测试 / 环境变量 CAREER_VAULT_KEY=64 位 hex）。 */
export class StaticKeyProvider implements KeyProvider {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('私密库密钥必须是 32 字节') }
  getKey(): Buffer { return this.key }
}
export function keyProviderFromEnv(fallbackFile: string): KeyProvider {
  const hex = process.env.CAREER_VAULT_KEY
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex.trim())) return new StaticKeyProvider(Buffer.from(hex.trim(), 'hex'))
  return new FileKeyProvider(fallbackFile)
}

// ---------- 字段定义（UI 表单与填表别名共用） ----------
export interface ProfileFieldDef { field: string; label: string; sensitive: boolean; group: 'identity' | 'contact' | 'education' | 'preference'; hint?: string }
export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  { field: 'name', label: '真实姓名', sensitive: true, group: 'identity' },
  { field: 'gender', label: '性别', sensitive: false, group: 'identity' },
  { field: 'birthday', label: '出生日期', sensitive: true, group: 'identity', hint: '如 2002-05-01' },
  { field: 'idNumber', label: '身份证号', sensitive: true, group: 'identity', hint: '只用于网申表单的证件号字段，永远不会给模型' },
  { field: 'ethnicity', label: '民族', sensitive: false, group: 'identity' },
  { field: 'politics', label: '政治面貌', sensitive: false, group: 'identity' },
  { field: 'hometown', label: '籍贯 / 户口所在地', sensitive: true, group: 'identity' },
  { field: 'phone', label: '手机号', sensitive: true, group: 'contact' },
  { field: 'email', label: '邮箱', sensitive: true, group: 'contact' },
  { field: 'wechat', label: '微信号', sensitive: true, group: 'contact' },
  { field: 'address', label: '通讯地址', sensitive: true, group: 'contact' },
  { field: 'emergencyContact', label: '紧急联系人（姓名 + 电话）', sensitive: true, group: 'contact' },
  { field: 'school', label: '毕业院校', sensitive: false, group: 'education' },
  { field: 'major', label: '专业', sensitive: false, group: 'education' },
  { field: 'degree', label: '最高学历', sensitive: false, group: 'education', hint: '本科 / 硕士 / 博士' },
  { field: 'graduation', label: '毕业时间', sensitive: false, group: 'education', hint: '如 2026-06' },
  { field: 'englishLevel', label: '英语水平', sensitive: false, group: 'education' },
  { field: 'city', label: '现居 / 期望城市', sensitive: false, group: 'preference' },
  { field: 'availableDate', label: '到岗时间', sensitive: false, group: 'preference' },
  { field: 'linkedin', label: '领英', sensitive: false, group: 'preference' },
  { field: 'github', label: 'GitHub', sensitive: false, group: 'preference' },
  { field: 'portfolio', label: '作品集 / 个人网站', sensitive: false, group: 'preference' },
]
export const SITE_FIELDS = ['username', 'password', 'note'] as const
const profileDef = (field: string) => PROFILE_FIELDS.find(f => f.field === field)

// ---------- 占位符 ----------
/** {{vault:profile.phone}} / {{vault:exp.exp_xxx.org}} / {{vault:site.www.zhaopin.com.username}} */
export const VAULT_PLACEHOLDER_RX = /\{\{\s*vault:(profile|exp|site)\.([^{}\s]+?)\s*\}\}/g
export function vaultPlaceholder(scope: VaultScope, ref_id: string, field: string): string {
  if (scope === 'profile') return `{{vault:profile.${field}}}`
  return `{{vault:${scope === 'experience' ? 'exp' : 'site'}.${ref_id}.${field}}}`
}
export function parseVaultPlaceholder(token: string): { scope: VaultScope; ref_id: string; field: string } | null {
  const m = new RegExp(VAULT_PLACEHOLDER_RX.source).exec(token)
  if (!m) return null
  const kind = m[1]; const rest = m[2]
  if (kind === 'profile') return { scope: 'profile', ref_id: '', field: rest }
  const i = rest.lastIndexOf('.')
  if (i <= 0) return null
  return { scope: kind === 'exp' ? 'experience' : 'site', ref_id: rest.slice(0, i), field: rest.slice(i + 1) }
}
export function hasVaultPlaceholder(text: string): boolean { return new RegExp(VAULT_PLACEHOLDER_RX.source).test(text) }

/** 脱敏预览：给 UI 列表与模型侧 status() 用，永远不含完整值。 */
export function maskValue(field: string, value: string): string {
  const v = value.trim()
  if (!v) return ''
  if (field === 'password') return ''
  if (field === 'email') { const [u, d] = v.split('@'); return d ? `${u.slice(0, 1)}***@${d}` : `${v.slice(0, 1)}***` }
  if (/phone|mobile|tel/i.test(field) && v.replace(/\D/g, '').length >= 7) { const d = v.replace(/\D/g, ''); return `${d.slice(0, 3)}****${d.slice(-4)}` }
  if (field === 'idNumber') return v.length > 6 ? `${v.slice(0, 3)}${'*'.repeat(Math.max(4, v.length - 5))}${v.slice(-2)}` : '***'
  if (field === 'name') return v.length <= 1 ? '*' : `${v.slice(0, 1)}${'*'.repeat(Math.min(3, v.length - 1))}`
  if (v.length <= 2) return '*'.repeat(v.length)
  return `${v.slice(0, 1)}***${v.length > 6 ? v.slice(-1) : ''}`
}

// ---------- 加解密 ----------
const aad = (scope: string, ref_id: string, field: string) => Buffer.from(`${scope}|${ref_id}|${field}`, 'utf8')
export function encryptValue(key: Buffer, plaintext: string, scope: string, ref_id: string, field: string): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad(scope, ref_id, field))
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), data])
}
export function decryptValue(key: Buffer, blob: Uint8Array, scope: string, ref_id: string, field: string): string {
  const b = Buffer.from(blob)
  if (b.length < 28) throw new Error('私密库密文损坏')
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(aad(scope, ref_id, field))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

// ---------- Vault ----------
export interface VaultStatus {
  profile: { filled: Array<{ field: string; label: string; preview: string; sensitive: boolean }>; missing: Array<{ field: string; label: string }> }
  sites: Array<{ host: string; label: string | null; hasUsername: boolean; hasPassword: boolean; autofill: boolean }>
  experiences: Array<{ experience_id: string; fields: Array<{ field: string; label: string | null; placeholder: string }> }>
}

export class Vault {
  constructor(public readonly db: Db, private keys: KeyProvider) {}
  private get key(): Buffer { return this.keys.getKey() }

  private toMeta(r: VaultRow): VaultItemMeta {
    let policy: VaultPolicy = {}
    try { policy = JSON.parse(r.policy_json || '{}') as VaultPolicy } catch { /* 坏数据按空策略 */ }
    return { id: r.id, scope: r.scope, ref_id: r.ref_id, field: r.field, label: r.label, preview: r.preview, sensitive: !!r.sensitive, policy, created_at: r.created_at, updated_at: r.updated_at }
  }
  private row(ref: string | { scope: VaultScope; ref_id?: string; field: string }): VaultRow | undefined {
    if (typeof ref === 'string') return this.db.get<VaultRow>('SELECT * FROM vault_item WHERE id=?', [ref])
    return this.db.get<VaultRow>('SELECT * FROM vault_item WHERE scope=? AND ref_id=? AND field=?', [ref.scope, ref.ref_id ?? '', ref.field])
  }
  private decrypt(r: VaultRow): string { return decryptValue(this.key, r.ciphertext, r.scope, r.ref_id, r.field) }
  private log(itemId: string | null, access: VaultAccess): void {
    this.db.insert('vault_access_log', { id: newId('vlg'), item_id: itemId, actor: access.actor, purpose: access.purpose ?? null, at: now() })
  }

  /** 写入 / 覆盖一项；value 为空串等于删除。 */
  set(input: VaultSetInput): VaultItemMeta | undefined {
    const ref_id = (input.ref_id ?? '').trim()
    const field = input.field.trim()
    if (!field) throw new Error('私密库字段名不能为空')
    if (input.scope !== 'profile' && !ref_id) throw new Error('site / experience 作用域必须提供 ref_id')
    const existing = this.row({ scope: input.scope, ref_id, field })
    if (!input.value.trim()) { if (existing) this.delete(existing.id); return undefined }
    const def = input.scope === 'profile' ? profileDef(field) : undefined
    const sensitive = input.sensitive !== undefined ? input.sensitive : existing ? !!existing.sensitive : def ? def.sensitive : true
    const label = input.label === undefined ? (existing?.label ?? def?.label ?? null) : input.label
    const policy = input.policy ?? (existing ? this.toMeta(existing).policy : {})
    const t = now()
    const ciphertext = encryptValue(this.key, input.value, input.scope, ref_id, field)
    const preview = sensitive ? maskValue(field, input.value) : input.value
    if (existing) {
      this.db.update('vault_item', existing.id, { label, ciphertext, preview, sensitive: sensitive ? 1 : 0, policy_json: JSON.stringify(policy), updated_at: t })
      return this.toMeta(this.row(existing.id)!)
    }
    const id = newId('vlt')
    this.db.insert('vault_item', { id, scope: input.scope, ref_id, field, label, ciphertext, preview, sensitive: sensitive ? 1 : 0, policy_json: JSON.stringify(policy), created_at: t, updated_at: t })
    return this.toMeta(this.row(id)!)
  }
  setPolicy(id: string, policy: VaultPolicy): VaultItemMeta {
    const r = this.row(id); if (!r) throw new Error('私密项不存在')
    this.db.update('vault_item', id, { policy_json: JSON.stringify({ ...this.toMeta(r).policy, ...policy }), updated_at: now() })
    return this.toMeta(this.row(id)!)
  }
  delete(id: string): boolean { return this.db.run('DELETE FROM vault_item WHERE id=?', [id]).changes > 0 }
  deleteSite(host: string): number { return this.db.run('DELETE FROM vault_item WHERE scope=? AND ref_id=?', ['site', host]).changes }

  /** 元数据列表：没有明文。 */
  list(scope?: VaultScope, ref_id?: string): VaultItemMeta[] {
    const rows = scope
      ? ref_id !== undefined
        ? this.db.all<VaultRow>('SELECT * FROM vault_item WHERE scope=? AND ref_id=? ORDER BY field', [scope, ref_id])
        : this.db.all<VaultRow>('SELECT * FROM vault_item WHERE scope=? ORDER BY ref_id, field', [scope])
      : this.db.all<VaultRow>('SELECT * FROM vault_item ORDER BY scope, ref_id, field')
    return rows.map(r => this.toMeta(r))
  }
  get(id: string): VaultItemMeta | undefined { const r = this.row(id); return r ? this.toMeta(r) : undefined }

  /** 解密一项（写访问日志）。只能在 Node 侧调用，结果不得进入模型上下文。 */
  reveal(ref: string | { scope: VaultScope; ref_id?: string; field: string }, access: VaultAccess): string | undefined {
    const r = this.row(ref)
    if (!r) return undefined
    this.log(r.id, access)
    return this.decrypt(r)
  }
  /** 解密某作用域下的全部字段。 */
  revealAll(scope: VaultScope, ref_id: string, access: VaultAccess): Record<string, string> {
    const rows = this.db.all<VaultRow>('SELECT * FROM vault_item WHERE scope=? AND ref_id=?', [scope, ref_id])
    const out: Record<string, string> = {}
    if (rows.length) this.log(null, { ...access, purpose: `${access.purpose ?? ''}[${scope}:${ref_id || '-'} ×${rows.length}]` })
    for (const r of rows) out[r.field] = this.decrypt(r)
    return out
  }
  /** 本人基本信息（明文）：给填表引擎。 */
  profileBasics(access: VaultAccess): Record<string, string> { return this.revealAll('profile', '', access) }
  /** 非敏感的基本信息（学校 / 专业 / 学历…）：允许进模型上下文。 */
  profileSafeBasics(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const r of this.db.all<VaultRow>('SELECT * FROM vault_item WHERE scope=? AND sensitive=0', ['profile'])) out[r.field] = this.decrypt(r)
    return out
  }
  /** 站点账号：按 host 精确或后缀匹配（campus.zhaopin.com 命中 zhaopin.com）。 */
  credential(host: string, access: VaultAccess): { host: string; username?: string; password?: string; note?: string; autofill: boolean } | undefined {
    const h = normalizeHost(host)
    const hosts = this.db.all<{ ref_id: string }>('SELECT DISTINCT ref_id FROM vault_item WHERE scope=?', ['site']).map(x => x.ref_id)
    const hit = hosts.filter(x => h === x || h.endsWith('.' + x)).sort((a, b) => b.length - a.length)[0]
    if (!hit) return undefined
    const vals = this.revealAll('site', hit, access)
    const metas = this.list('site', hit)
    const autofill = metas.some(m => m.policy.autofill === true)
    return { host: hit, username: vals.username, password: vals.password, note: vals.note, autofill }
  }
  /** 经历的保密补充字段（明文）。 */
  experienceSupplement(experienceId: string, access: VaultAccess): Record<string, string> { return this.revealAll('experience', experienceId, access) }

  /** 把文本里的占位符替换成明文；找不到的占位符保留原样（调用方可据此提示缺项）。 */
  resolve(text: string, access: VaultAccess): string {
    if (!text || !text.includes('{{')) return text
    const cache = new Map<string, string | undefined>()
    return text.replace(new RegExp(VAULT_PLACEHOLDER_RX.source, 'g'), (token) => {
      const p = parseVaultPlaceholder(token)
      if (!p) return token
      const k = `${p.scope}|${p.ref_id}|${p.field}`
      if (!cache.has(k)) cache.set(k, this.reveal({ scope: p.scope, ref_id: p.ref_id, field: p.field }, access))
      const v = cache.get(k)
      return v === undefined ? token : v
    })
  }
  resolveDeep<T>(value: T, access: VaultAccess): T { return mapStrings(value, s => this.resolve(s, access)) }
  /** 列出文本里引用了但库里没有的占位符。 */
  unresolved(text: string): string[] {
    const out = new Set<string>()
    for (const m of text.matchAll(new RegExp(VAULT_PLACEHOLDER_RX.source, 'g'))) {
      const p = parseVaultPlaceholder(m[0])
      if (p && !this.row({ scope: p.scope, ref_id: p.ref_id, field: p.field })) out.add(m[0])
    }
    return [...out]
  }

  /**
   * 最后一道防线：把文本里出现的敏感明文替换回占位符。
   * 为避免误伤：中文等非 ASCII 值至少 2 字（张三）；纯 ASCII 值至少 4 字且按词边界匹配（用户名 tom 不会吃掉 tomorrow）。
   */
  redact(text: string): string {
    if (!text) return text
    return applyRedactions(text, this.sensitiveValues())
  }
  redactDeep<T>(value: T): T {
    const pairs = this.sensitiveValues()
    if (!pairs.length) return value
    return mapStrings(value, s => applyRedactions(s, pairs))
  }
  private sensitiveValues(): Redaction[] {
    const rows = this.db.all<VaultRow>('SELECT * FROM vault_item WHERE sensitive=1')
    return rows
      .map(r => ({ value: this.decrypt(r).trim(), token: vaultPlaceholder(r.scope, r.ref_id, r.field) }))
      .filter(x => (ASCII_RX.test(x.value) ? x.value.length >= 4 : x.value.length >= 2))
      .sort((a, b) => b.value.length - a.value.length)
  }

  /** 给模型 / UI 的概览：只有字段名、标签、脱敏预览和占位符，没有明文。 */
  status(): VaultStatus {
    const items = this.list()
    const profile = items.filter(i => i.scope === 'profile')
    const filled = profile.map(i => ({ field: i.field, label: i.label ?? profileDef(i.field)?.label ?? i.field, preview: i.preview ?? '', sensitive: i.sensitive }))
    const have = new Set(profile.map(i => i.field))
    const missing = PROFILE_FIELDS.filter(f => !have.has(f.field)).map(f => ({ field: f.field, label: f.label }))
    const siteMap = new Map<string, VaultStatus['sites'][number]>()
    for (const i of items.filter(i => i.scope === 'site')) {
      const s = siteMap.get(i.ref_id) ?? { host: i.ref_id, label: null, hasUsername: false, hasPassword: false, autofill: false }
      if (i.field === 'username') { s.hasUsername = true; s.label = s.label ?? i.label }
      if (i.field === 'password') s.hasPassword = true
      if (i.policy.autofill) s.autofill = true
      siteMap.set(i.ref_id, s)
    }
    const expMap = new Map<string, VaultStatus['experiences'][number]>()
    for (const i of items.filter(i => i.scope === 'experience')) {
      const e = expMap.get(i.ref_id) ?? { experience_id: i.ref_id, fields: [] }
      e.fields.push({ field: i.field, label: i.label, placeholder: vaultPlaceholder('experience', i.ref_id, i.field) })
      expMap.set(i.ref_id, e)
    }
    return { profile: { filled, missing }, sites: [...siteMap.values()], experiences: [...expMap.values()] }
  }
  accessLog(limit = 100): Array<{ id: string; item_id: string | null; actor: string; purpose: string | null; at: string }> {
    return this.db.all('SELECT * FROM vault_access_log ORDER BY at DESC LIMIT ?', [limit])
  }
}

interface Redaction { value: string; token: string }
const ASCII_RX = /^[\x21-\x7e]+$/
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function applyRedactions(text: string, pairs: Redaction[]): string {
  let out = text
  for (const { value, token } of pairs) {
    if (!out.includes(value)) continue
    if (ASCII_RX.test(value)) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRx(value)}(?![A-Za-z0-9])`, 'g'), token)
    else out = out.split(value).join(token)
  }
  return out
}

export function normalizeHost(urlOrHost: string): string {
  let h = urlOrHost.trim().toLowerCase()
  try { if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname } catch { /* 不是 URL 就当 host */ }
  return h.replace(/^www\./, '').replace(/[/:].*$/, '')
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn)) as unknown as T
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn)
    return out as T
  }
  return value
}
