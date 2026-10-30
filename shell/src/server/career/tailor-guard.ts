/**
 * 定制简历的防编造闸门：模型给的改动先过这里，再写进定制版。防编造靠工具，不靠对话里事后自查（10-30 实测：
 * 定制把两段实习的内容串了位、加了用户没说过的实现细节，助理事后在长文里自己回退）。
 *
 * 规则（拦下的改动不进简历，原因列在「改了什么」卡上）：
 *  1. 事实字段不改：机构、职位、部门、起止时间、学校、学历、专业、项目名，基本信息里除求职意向外都不改。
 *  2. 不串位：一条改动引用的主张属于别的经历，或新写的内容里出现了只属于别的条目的数字 / 英文术语。
 *  3. 不加料：新内容里的数字和英文术语（工具、框架、指标名）必须在这一条的原文或它的已确认主张里出现过。
 * 删除和调整顺序不算编造，一律放行。
 */
import type { Claim } from '@career/core';

import type { TailorOp, TailorReason } from './tailor';

const ENTRY_SECTIONS: ReadonlySet<string> = new Set(['education', 'experience', 'projects', 'awards', 'certifications']);
const FACT_FIELDS: ReadonlySet<string> = new Set(['org', 'position', 'department', 'start', 'end', 'school', 'degree', 'major', 'name', 'issuer', 'date', 'location']);
const BASICS_EDITABLE: ReadonlySet<string> = new Set(['objective', 'summary']);
const FREE_SECTIONS: ReadonlySet<string> = new Set(['section_order', 'section_titles']);
/** 数字（含小数、百分号）与英文术语（≥2 个字符，允许 + # . -，如 C++、Node.js、k8s）。 */
const NUMBER_RX = /\d+(?:\.\d+)?%?/g;
const LATIN_RX = /[A-Za-z][A-Za-z0-9+#.-]+/g;

export interface BlockedOp { path: string; why: string; after: string | null }

type Entry = Record<string, unknown>;
const asEntry = (v: unknown): Entry => (v && typeof v === 'object' && !Array.isArray(v) ? v as Entry : {});
const texts = (v: unknown): string[] => {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === 'object') return Object.values(v as Entry).flatMap(texts);
  return [];
};
const tokens = (text: string): string[] => [...(text.match(NUMBER_RX) ?? []), ...(text.match(LATIN_RX) ?? []).map(t => t.replace(/[.-]+$/, ''))].filter(t => t.length > 0);
const claimText = (c: Claim) => `${c.text} ${c.result_metric ?? ''}`;

/** 新内容里没在依据里出现过的数字 / 英文术语。 */
export function unsupportedTokens(text: string, pool: string): string[] {
  const hay = pool.toLowerCase();
  return [...new Set(tokens(text))].filter(t => !hay.includes(t.toLowerCase()));
}

interface GuardCtx { master: Entry; claims: Claim[]; byId: Map<string, Claim> }

/** 一个条目自己的依据：原文 + 它引用的已确认主张；拿到它对应的经历集合（用来判断串位）。 */
function entryBasis(ctx: GuardCtx, section: string, idx: number): { pool: string; experiences: Set<string> } {
  const entry = asEntry((ctx.master[section] as unknown[] | undefined)?.[idx]);
  const ids = Array.isArray(entry.claim_ids) ? entry.claim_ids.filter((x): x is string => typeof x === 'string') : [];
  const own = ids.map(id => ctx.byId.get(id)).filter((c): c is Claim => !!c);
  const experiences = new Set(own.map(c => c.experience_id));
  const sameExp = ctx.claims.filter(c => experiences.has(c.experience_id) && c.status !== 'pending');
  return { pool: [...texts(entry), ...sameExp.map(claimText)].join('\n'), experiences };
}

const globalPool = (ctx: GuardCtx) => [...texts(ctx.master), ...ctx.claims.filter(c => c.status !== 'pending').map(claimText)].join('\n');

function checkEntryOp(ctx: GuardCtx, op: TailorOp, reason: TailorReason | undefined, parts: string[]): string | null {
  const [section, rawIdx, field] = parts;
  const idx = Number(rawIdx);
  if (!Number.isInteger(idx)) return null;
  const original = asEntry((ctx.master[section] as unknown[] | undefined)?.[idx]);
  if (field && FACT_FIELDS.has(field)) return '改了事实字段（机构 / 职位 / 时间 / 学校这类不改）';
  if (!field && op.op === 'replace') {
    const next = asEntry(op.value);
    const changed = [...FACT_FIELDS].find(k => typeof original[k] === 'string' && original[k] && next[k] !== original[k]);
    if (changed) return '整条换成了另一段经历的内容（机构 / 时间对不上）';
  }
  const basis = entryBasis(ctx, section, idx);
  const cited = (reason?.claim_ids ?? []).map(id => ctx.byId.get(id)).filter((c): c is Claim => !!c);
  if (basis.experiences.size && cited.some(c => !basis.experiences.has(c.experience_id))) return '用了另一段经历的主张（串位）';
  const pool = basis.experiences.size ? `${basis.pool}\n${cited.map(claimText).join('\n')}` : globalPool(ctx);
  const extra = unsupportedTokens(texts(op.value).join('\n'), pool);
  return extra.length ? `出现了没有依据的内容：${extra.slice(0, 4).join('、')}` : null;
}

/** 一条改动该不该拦；返回拦下的原因，放行返回 null。 */
function verdict(ctx: GuardCtx, op: TailorOp, reason: TailorReason | undefined): string | null {
  if (op.op === 'remove') return null;
  const parts = op.path.split('/').slice(1);
  const [section, field] = parts;
  if (FREE_SECTIONS.has(section)) return null;
  if (section === 'basics') return field && BASICS_EDITABLE.has(field) ? null : '改了基本信息（只允许改求职意向）';
  if (ENTRY_SECTIONS.has(section) && parts.length >= 2) return checkEntryOp(ctx, op, reason, parts);
  const extra = unsupportedTokens(texts(op.value).join('\n'), globalPool(ctx));
  return extra.length ? `出现了没有依据的内容：${extra.slice(0, 4).join('、')}` : null;
}

export function guardTailorOps(master: unknown, ops: TailorOp[], reasons: TailorReason[], claims: Claim[]): { ops: TailorOp[]; blocked: BlockedOp[] } {
  const ctx: GuardCtx = { master: asEntry(master), claims, byId: new Map(claims.map(c => [c.id, c])) };
  const kept: TailorOp[] = [];
  const blocked: BlockedOp[] = [];
  for (const op of ops) {
    const why = verdict(ctx, op, reasons.find(r => r.path === op.path));
    if (why) blocked.push({ path: op.path, why, after: texts(op.value).join(' / ') || null });
    else kept.push(op);
  }
  return { ops: kept, blocked };
}
