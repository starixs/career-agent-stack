/**
 * 交简历（冷启动 / 准备期主链路第一步）：用户拖进一份简历，一次收完。
 *
 * - 基本信息：简历上有的直接补进私密库（只补空着的，不覆盖用户填过的）；手机、邮箱用本地正则取，不靠模型。
 * - 经历：按简历上的段落各建一条经历，主张待确认、带原文证据；不再把整份简历塞进一条以文件名命名的经历。
 * - 教育、技能、奖项：存成一份导入草稿（kv），用户在卡片里点一下确认后，直接组装成主简历，不再让模型起草、
 *   也不再在对话里问学校全名和起止时间。
 * 立场 9：简历里已有的不问；缺的在同一张卡里一次补完。立场 3：只有用户勾过的说法进主简历。
 */
import type { Claim, Experience, Repos, Vault } from '@career/core';

import type { CareerStore } from './store';

/** 一份简历里最多收几段经历、每段最多几条说法：防止模型把整页切成碎片。 */
const MAX_ENTRIES = 12;
const MAX_CLAIMS_PER_ENTRY = 8;
export const INTAKE_KV_PREFIX = 'resume_intake:';
/** 卡片里必须补齐的基本信息（网申表几乎都要）；其余资料用到时再问。 */
export const INTAKE_CORE_FIELDS = ['name', 'phone', 'email', 'school', 'major', 'degree', 'graduation'] as const;

export type IntakeSection = 'experience' | 'project' | 'campus';
export interface IntakeClaim { text: string; attribution: 'self' | 'team' | 'unknown'; result_metric: string; excerpt: string }
export interface IntakeEntry { section: IntakeSection; title: string; org: string; role: string; start: string; end: string; claims: IntakeClaim[] }
export interface IntakeEducation { school: string; degree: string; major: string; start: string; end: string; gpa: string; courses: string[] }
export interface ResumeParse {
  profile: Partial<Record<'name' | 'school' | 'major' | 'degree' | 'graduation' | 'city', string>>;
  direction: string;
  education: IntakeEducation[];
  entries: IntakeEntry[];
  skills: Array<{ name: string; keywords: string[] }>;
  awards: Array<{ title: string; date: string }>;
  certifications: Array<{ title: string; date: string }>;
}

/** 落在 kv 里的导入草稿：确认时据此组装主简历。只存非私密的结构，私密值在私密库。 */
export interface IntakeDraft {
  id: string;
  source: string;
  direction: string;
  education: IntakeEducation[];
  entries: Array<{ experience_id: string; section: IntakeSection; title: string; org: string; role: string; start: string; end: string }>;
  skills: ResumeParse['skills'];
  awards: ResumeParse['awards'];
  certifications: ResumeParse['certifications'];
  master_id: string | null;
  created_at: string;
  /** 简历和资料（私密库）对不上的字段；卡片里选「以哪份为准」，确认后清空。 */
  conflicts?: string[];
  /**
   * 冲突字段在简历上的值，确认时若选「以简历为准」写进私密库，随即删掉。
   * 只在本机库里、不进模型和卡片（卡片只给打码预览）；简历原文本身已在本机工作区。
   */
  pending_profile?: Record<string, string>;
}

// ---------- 模型输出校验（跨边界数据） ----------
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => arr(v).map(s).filter(Boolean);
const SECTIONS: ReadonlySet<string> = new Set(['experience', 'project', 'campus']);
const ATTRIBUTIONS: ReadonlySet<string> = new Set(['self', 'team', 'unknown']);

function parseClaim(raw: unknown): IntakeClaim | null {
  const c = obj(raw);
  const text = s(c.text);
  if (!text) return null;
  const attribution = ATTRIBUTIONS.has(s(c.attribution)) ? s(c.attribution) as IntakeClaim['attribution'] : 'self';
  const metric = s(c.result_metric);
  return { text, attribution, result_metric: metric === '未知' ? '' : metric, excerpt: s(c.excerpt) };
}

function parseEntry(raw: unknown): IntakeEntry | null {
  const e = obj(raw);
  const title = s(e.title) || [s(e.org), s(e.role)].filter(Boolean).join(' · ');
  if (!title) return null;
  const section = SECTIONS.has(s(e.section)) ? s(e.section) as IntakeSection : 'experience';
  const claims = arr(e.claims).map(parseClaim).filter((c): c is IntakeClaim => !!c).slice(0, MAX_CLAIMS_PER_ENTRY);
  return { section, title, org: s(e.org), role: s(e.role), start: s(e.start), end: s(e.end), claims };
}

/** 把模型给的 JSON 收成固定结构；不合法的条目丢掉，不让脏数据进库。 */
export function parseResumeParse(raw: unknown): ResumeParse {
  const r = obj(raw);
  const p = obj(r.profile);
  const profile: ResumeParse['profile'] = {};
  for (const k of ['name', 'school', 'major', 'degree', 'graduation', 'city'] as const) { const v = s(p[k]); if (v) profile[k] = v; }
  const education = arr(r.education).map(obj).map(e => ({ school: s(e.school), degree: s(e.degree), major: s(e.major), start: s(e.start), end: s(e.end), gpa: s(e.gpa), courses: strs(e.courses) })).filter(e => e.school);
  return {
    profile, direction: s(r.direction), education,
    entries: arr(r.entries).map(parseEntry).filter((e): e is IntakeEntry => !!e).slice(0, MAX_ENTRIES),
    skills: arr(r.skills).map(obj).map(x => ({ name: s(x.name), keywords: strs(x.keywords) })).filter(x => x.name || x.keywords.length),
    awards: arr(r.awards).map(obj).map(x => ({ title: s(x.title), date: s(x.date) })).filter(x => x.title),
    certifications: arr(r.certifications).map(obj).map(x => ({ title: s(x.title), date: s(x.date) })).filter(x => x.title),
  };
}

// ---------- 本地取联系方式（不经模型） ----------
const PHONE_RX = /(?<!\d)(?:\+?86[\s-]?)?(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})(?!\d)/;
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function extractContacts(text: string): { phone?: string; email?: string } {
  const phone = PHONE_RX.exec(text)?.[1]?.replace(/[\s-]/g, '');
  const email = EMAIL_RX.exec(text)?.[0];
  return { ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
}

/** 「2027.06」「2027-06」「2027年6月」→ 2027-06；认不出原样返回。 */
export function toYearMonth(v: string): string {
  const m = /(\d{4})\s*[.\-/年]\s*(\d{1,2})/.exec(v);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : v;
}

// ---------- 导入 ----------
export interface IntakeDeps { repos: Repos; vault: Vault; now?: () => string; newId?: () => string }
export interface IntakeResult {
  draft: IntakeDraft;
  experiences: Array<{ experience: Experience; claims: Claim[] }>;
  /** 这次从简历补进私密库的字段（只有字段名，不含值）。 */
  filled: string[];
  /** 简历和资料对不上的字段（只有字段名）。 */
  conflicts: string[];
  /** 卡片里还要用户补的核心字段（简历上也没有）。 */
  missing: string[];
}

const norm = (field: string, v: string) => (field === 'graduation' ? toYearMonth(v) : v).replace(/\s+/g, '').toLowerCase();

/**
 * 简历上的基本信息对照私密库：空着的直接补；已有且一致的不动；已有但不一样的记成冲突，交给卡片选（不在对话里对账）。
 */
function reconcileProfile(vault: Vault, values: Record<string, string>): { filled: string[]; conflicts: Record<string, string> } {
  const existing = new Map(vault.list().filter(i => i.scope === 'profile').map(i => [i.field, i.id]));
  const filled: string[] = [];
  const conflicts: Record<string, string> = {};
  for (const [field, value] of Object.entries(values)) {
    if (!value) continue;
    const id = existing.get(field);
    if (!id) { vault.set({ scope: 'profile', field, value }); filled.push(field); continue; }
    const current = vault.reveal(id, { actor: 'resolve', purpose: '交简历：比对上传的简历和基本资料是否一致' }) ?? '';
    if (norm(field, current) !== norm(field, value)) conflicts[field] = value;
  }
  return { filled, conflicts };
}

function profileValues(text: string, parsed: ResumeParse): Record<string, string> {
  const edu = parsed.education[0];
  const p = parsed.profile;
  return {
    name: p.name ?? '',
    ...extractContacts(text),
    school: p.school || edu?.school || '',
    major: p.major || edu?.major || '',
    degree: p.degree || edu?.degree || '',
    graduation: toYearMonth(p.graduation || edu?.end || ''),
    city: p.city ?? '',
  };
}

export function importResume(deps: IntakeDeps, input: { text: string; source: string; locator: string; parsed: ResumeParse }): IntakeResult {
  const { repos, vault } = deps;
  const now = deps.now?.() ?? new Date().toISOString();
  const id = deps.newId?.() ?? `rin_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const { filled, conflicts } = reconcileProfile(vault, profileValues(input.text, input.parsed));
  const experiences = input.parsed.entries.map(e => {
    const experience = repos.createExperience({ title: e.title, org: e.org || null, role: e.role || null, start_date: toYearMonth(e.start) || null, end_date: toYearMonth(e.end) || null, type: 'other', summary: `由简历《${input.source}》导入` });
    const claims = e.claims.map(c => {
      const claim = repos.addClaim({ experience_id: experience.id, text: c.text, attribution: c.attribution, result_metric: c.result_metric || null, created_from: 'doc' });
      repos.addEvidence({ claim_id: claim.id, kind: 'doc_fragment', locator: input.locator, excerpt: c.excerpt || null, strength: 'mid' });
      return claim;
    });
    return { experience, claims };
  });
  const draft: IntakeDraft = {
    id, source: input.source, direction: input.parsed.direction, education: input.parsed.education,
    entries: input.parsed.entries.map((e, i) => ({ experience_id: experiences[i].experience.id, section: e.section, title: e.title, org: e.org, role: e.role, start: e.start, end: e.end })),
    skills: input.parsed.skills, awards: input.parsed.awards, certifications: input.parsed.certifications,
    master_id: null, created_at: now,
    ...(Object.keys(conflicts).length ? { conflicts: Object.keys(conflicts), pending_profile: conflicts } : {}),
  };
  repos.kvSet(`${INTAKE_KV_PREFIX}${id}`, draft);
  const have = new Set(vault.status().profile.filled.map(f => f.field));
  return { draft, experiences, filled, conflicts: Object.keys(conflicts), missing: INTAKE_CORE_FIELDS.filter(f => !have.has(f)) };
}

export function getIntakeDraft(repos: Repos, id: string): IntakeDraft | undefined {
  return repos.kvGet<IntakeDraft>(`${INTAKE_KV_PREFIX}${id}`);
}

// ---------- 组装主简历 ----------
const dot = (v: string) => v.replace(/-/g, '.');

const EDUCATION_FROM_VAULT: ReadonlyArray<[string, keyof IntakeEducation]> = [['school', 'school'], ['major', 'major'], ['degree', 'degree'], ['graduation', 'end']];

/**
 * 只用确认过的说法：一段经历一条，说法一条一句；没有确认说法的段落不进简历。
 * keptVault：冲突里用户选了「以资料为准」的字段，教育背景对应项写私密库占位符，不用简历上的值。
 */
export function buildMasterSchema(draft: IntakeDraft, claims: Claim[], vaultFilled: ReadonlySet<string>, placeholder: (field: string) => string, keptVault: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const confirmed = claims.filter(c => c.status !== 'pending');
  const byExp = (experienceId: string) => confirmed.filter(c => c.experience_id === experienceId);
  const basics: Record<string, string> = {};
  for (const [field, key] of [['name', 'name'], ['phone', 'phone'], ['email', 'email'], ['city', 'city']] as const) {
    if (vaultFilled.has(field)) basics[key] = placeholder(field);
  }
  if (draft.direction) basics.objective = draft.direction;
  const rows = draft.entries.map(e => ({ e, cs: byExp(e.experience_id) })).filter(x => x.cs.length);
  const bullets = (cs: Claim[]) => ({ bullets: cs.map(c => c.text), claim_ids: cs.map(c => c.id) });
  return {
    version: 1, basics,
    education: draft.education.map((ed, i) => {
      const row: Record<string, unknown> = { ...ed, start: dot(ed.start), end: dot(ed.end) };
      if (i === 0) for (const [field, key] of EDUCATION_FROM_VAULT) if (keptVault.has(field)) row[key] = placeholder(field);
      return row;
    }),
    experience: rows.filter(x => x.e.section === 'experience').map(({ e, cs }) => ({ org: e.org || e.title, position: e.role, start: dot(e.start), end: dot(e.end), ...bullets(cs) })),
    projects: rows.filter(x => x.e.section === 'project').map(({ e, cs }) => ({ name: e.title, role: e.role, org: e.org, start: dot(e.start), end: dot(e.end), ...bullets(cs) })),
    custom_sections: rows.some(x => x.e.section === 'campus')
      ? [{ title: '校园经历', items: rows.filter(x => x.e.section === 'campus').map(({ e, cs }) => ({ title: e.title, subtitle: e.role, date: [dot(e.start), dot(e.end)].filter(Boolean).join(' - '), ...bullets(cs) })) }]
      : [],
    skills: draft.skills.map(x => ({ name: x.name, keywords: x.keywords })),
    awards: draft.awards,
    certifications: draft.certifications,
  };
}

export interface ConfirmDeps {
  repos: Repos; vault: Vault; store: CareerStore;
  placeholder: (field: string) => string;
  /** 简历 schema 校验（补默认值）。 */
  normalize: (input: unknown) => Promise<unknown>;
}

/**
 * 只保留一份主简历（2026-10-30 用户定）：已有主简历就覆盖最近改过的那份（覆盖前存快照，可回退），
 * 不另建第二份让定制时还要选。
 */
function currentMasterId(store: CareerStore): string | null {
  const masters = [...store.listResumeMasters()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return masters[0]?.id ?? null;
}

/**
 * 卡片里点「全部通过 / 只用所选」：确认勾选的说法，按导入草稿直接组装主简历（不调模型）。
 * 同一份导入再点一次只更新它生成的那份主简历；新拖进的简历替换现有主简历。
 */
export type ProfileChoice = Record<string, 'resume' | 'vault'>;

/** 冲突字段按用户选的写回：缺省以刚上传的简历为准（选一下全部同步）；返回选了「以资料为准」的字段。 */
function applyProfileChoice(vault: Vault, draft: IntakeDraft, choice: ProfileChoice): Set<string> {
  const kept = new Set<string>();
  for (const field of draft.conflicts ?? []) {
    const value = draft.pending_profile?.[field];
    if (choice[field] === 'vault' || !value) { kept.add(field); continue; }
    vault.set({ scope: 'profile', field, value });
  }
  return kept;
}

/**
 * 卡片里点「全部通过 / 只用所选」：确认勾选的说法，冲突字段按选择写回，按导入草稿直接组装主简历（不调模型）。
 * 同一份导入再点一次只更新它生成的那份主简历；新拖进的简历替换现有主简历。
 */
export async function confirmIntake(deps: ConfirmDeps, id: string, claimIds: string[], choice: ProfileChoice = {}): Promise<{ master_id: string; confirmed: number; created: boolean }> {
  const { repos, store } = deps;
  const draft = getIntakeDraft(repos, id);
  if (!draft) throw new Error(`导入记录不存在：${id}`);
  const own = new Set(draft.entries.map(e => e.experience_id));
  const pick = new Set(claimIds);
  let confirmed = 0;
  for (const c of repos.listClaims()) if (own.has(c.experience_id) && pick.has(c.id) && c.status === 'pending') { repos.confirmClaim(c.id); confirmed++; }
  const kept = applyProfileChoice(deps.vault, draft, choice);
  const filled = new Set(deps.vault.status().profile.filled.map(f => f.field));
  const schema = await deps.normalize(buildMasterSchema(draft, repos.listClaims().filter(c => own.has(c.experience_id)), filled, deps.placeholder, kept));
  const reuse = draft.master_id && store.getResume(draft.master_id)?.kind === 'master' ? draft.master_id : currentMasterId(store);
  const masterId = reuse ? store.saveResume(reuse, schema, `从简历《${draft.source}》导入前快照`).id : store.createResumeMaster({ name: '主简历', direction: draft.direction || null, schema_json: schema }).id;
  const { pending_profile: _drop, ...rest } = draft;
  repos.kvSet(`${INTAKE_KV_PREFIX}${id}`, { ...rest, master_id: masterId, conflicts: [] });
  console.log(`[resume-intake] confirmed intake=${id} master=${masterId} claims=${confirmed} kept_vault=${kept.size}`);
  return { master_id: masterId, confirmed, created: !reuse };
}
