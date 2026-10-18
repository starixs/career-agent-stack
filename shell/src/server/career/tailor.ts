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
