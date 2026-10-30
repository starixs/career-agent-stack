/**
 * 简历定制（resume_tailor 产出的 JSON Patch）：解析模型输出并应用到简历 schema。
 * 改写只用已确认主张，生成后直接落库，不经过用户审核。
 */

/** 最小 JSON Patch（add / replace / remove），够用即可；复杂情况交给 @career/resume。 */
export function applyJsonPatch(doc: unknown, ops: Array<{ op: string; path: string; value?: unknown }>): unknown {
  const root = JSON.parse(JSON.stringify(doc)) as unknown;
  for (const op of ops) {
    if (!op || typeof op.path !== 'string') continue;
    const parts = op.path.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.length === 0) continue;
    let cur: unknown = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (Array.isArray(cur)) cur = cur[Number(key)];
      else if (cur && typeof cur === 'object') {
        const obj = cur as Record<string, unknown>;
        if (obj[key] === undefined && (op.op === 'add' || op.op === 'replace')) obj[key] = /^\d+$/.test(parts[i + 1]) || parts[i + 1] === '-' ? [] : {};
        cur = obj[key];
      } else { cur = undefined; break; }
    }
    if (cur === undefined || cur === null) continue;
    const last = parts[parts.length - 1];
    if (Array.isArray(cur)) {
      const idx = last === '-' ? cur.length : Number(last);
      if (op.op === 'remove') cur.splice(idx, 1);
      else if (op.op === 'add') cur.splice(idx, 0, op.value);
      else if (op.op === 'replace') cur[idx] = op.value;
    } else if (typeof cur === 'object') {
      const obj = cur as Record<string, unknown>;
      if (op.op === 'remove') delete obj[last];
      else obj[last] = op.value;
    }
  }
  return root;
}

export interface TailorOp { op: string; path: string; value?: unknown; from?: string }
export interface TailorReason { path: string; reason?: string; claim_ids?: string[]; jd_keywords?: string[] }

/** 解析模型输出：兼容 patch / changes / operations 三种键名。 */
export function parseTailorProposal(raw: Record<string, unknown> | undefined): { ops: TailorOp[]; reasons: TailorReason[]; unresolved: unknown[] } {
  const rawOps = (raw?.patch ?? raw?.changes ?? raw?.operations) as unknown;
  const ops = Array.isArray(rawOps) ? (rawOps as TailorOp[]).filter(o => o && typeof o.path === 'string' && typeof o.op === 'string') : [];
  const reasons = Array.isArray(raw?.reasons) ? (raw!.reasons as TailorReason[]).filter(r => r && typeof r.path === 'string') : [];
  const unresolved = Array.isArray(raw?.unresolved) ? raw!.unresolved as unknown[] : [];
  return { ops, reasons, unresolved };
}

// ---------- 定制结果给人看：改了哪几处，原来是什么、现在是什么 ----------

/** 简历 schema 里能改的顶层键；模型常写错的复数 / 单数在这里收口，其余路径丢掉（否则改进一个不存在的键，简历看着没变）。 */
const SECTION_ALIASES: Record<string, string> = {
  basics: 'basics', education: 'education', experience: 'experience', experiences: 'experience', work: 'experience',
  projects: 'projects', project: 'projects', skills: 'skills', skill: 'skills', awards: 'awards', certifications: 'certifications',
  custom_sections: 'custom_sections', section_order: 'section_order', section_titles: 'section_titles',
};

/** 把路径的顶层键收口到 schema 里的写法；落不到简历上的返回 null。 */
export function normalizeTailorPath(path: string): string | null {
  const parts = path.split('/');
  const section = SECTION_ALIASES[parts[1] ?? ''];
  return section ? ['', section, ...parts.slice(2)].join('/') : null;
}

/** 修正顶层键并丢掉落不到简历上的改动；dropped 里是被丢掉的路径（记日志、不进简历）。理由的路径一起收口。 */
export function sanitizeTailorOps(ops: TailorOp[], reasons: TailorReason[] = []): { ops: TailorOp[]; reasons: TailorReason[]; dropped: string[] } {
  const kept: TailorOp[] = [];
  const dropped: string[] = [];
  for (const op of ops) {
    const path = normalizeTailorPath(op.path);
    if (!path || !['add', 'replace', 'remove'].includes(op.op)) { dropped.push(op.path); continue; }
    kept.push({ ...op, path });
  }
  return { ops: kept, reasons: reasons.map(r => ({ ...r, path: normalizeTailorPath(r.path) ?? r.path })), dropped };
}

const SECTION_LABEL: Record<string, string> = { basics: '基本信息', education: '教育', experience: '实习 / 工作', projects: '项目', skills: '技能', awards: '奖项', certifications: '证书', custom_sections: '其他经历' };

function at(doc: unknown, parts: string[]): unknown {
  let cur = doc;
  for (const p of parts) {
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

const show = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v.join('、');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const head = [o.org, o.name, o.position, o.title].filter(x => typeof x === 'string' && x).join(' · ');
    return head || JSON.stringify(v);
  }
  return String(v);
};

/** 「实习 / 工作 · 美团 · 第 2 条」：用户认得出的位置，不露 JSON 路径。 */
function placeOf(doc: unknown, parts: string[]): string {
  const [section, idx, field, sub] = parts;
  const out = [SECTION_LABEL[section] ?? section];
  if (idx !== undefined && /^\d+$/.test(idx)) {
    const entry = at(doc, [section, idx]) as Record<string, unknown> | undefined;
    const name = entry && [entry.org, entry.name, entry.title, entry.school].find(x => typeof x === 'string' && x);
    if (typeof name === 'string') out.push(name);
  }
  if (field === 'bullets' && sub !== undefined && /^\d+$/.test(sub)) out.push(`第 ${Number(sub) + 1} 条`);
  else if (field === 'bullets' && sub === '-') out.push('新加一条');
  return out.join(' · ');
}

export interface TailorChange { op: string; place: string; before: string | null; after: string | null; reason: string | null }

/** 每处改动：位置、原文（相对母版）、新文、理由。order 不改内容的重排也列出来，让人知道顺序动过。 */
export function describeTailorChanges(before: unknown, ops: TailorOp[], reasons: TailorReason[]): TailorChange[] {
  return ops.map(o => {
    const parts = o.path.split('/').slice(1);
    return {
      op: o.op,
      place: placeOf(before, parts),
      before: o.op === 'add' ? null : show(at(before, parts)),
      after: o.op === 'remove' ? null : show(o.value),
      reason: reasons.find(r => r.path === o.path)?.reason ?? null,
    };
  });
}
