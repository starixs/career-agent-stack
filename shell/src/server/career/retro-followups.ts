/**
 * 复盘回流经历库：面试里用户亲口说出、经历库还没有的事实 → 待确认的主张；答不上来的事实 → 「还要补」的清单。
 * 只出待确认卡，不改简历：已经投出的那版改不了，确认过的主张下次定制时才会用上（世界模型 §3.1、§5）。
 */
import type { Claim, Repos } from '@career/core';

/** 每段经历最多带几条：卡片要一眼能看完。 */
const MAX_PER_EXPERIENCE = 5;

export interface RetroFollowup { experience_id: string; experience_title: string; claims: Claim[]; gaps: string[] }

interface RawFollowup { experience_id: string; new_fact: string | null; attribution: 'self' | 'team' | 'unknown'; gap: string | null }

function parseFollowups(out: unknown): RawFollowup[] {
  const raw: unknown = out && typeof out === 'object' ? Reflect.get(out, 'claim_followups') : null;
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return raw.flatMap((f: unknown) => {
    if (!f || typeof f !== 'object') return [];
    const experience_id = text(Reflect.get(f, 'experience_id'));
    const attr = Reflect.get(f, 'attribution');
    const attribution = attr === 'self' || attr === 'team' ? attr : 'unknown';
    return experience_id ? [{ experience_id, new_fact: text(Reflect.get(f, 'new_fact')), attribution, gap: text(Reflect.get(f, 'gap')) }] : [];
  });
}

/** 把复盘结果里的 claim_followups 落成待确认主张，按经历分组返回（对不上经历的丢掉）。 */
export function applyRetroFollowups(repos: Repos, out: unknown): RetroFollowup[] {
  const experiences = new Map(repos.listExperiences().map(e => [e.id, e]));
  const groups = new Map<string, RetroFollowup>();
  for (const f of parseFollowups(out)) {
    const exp = experiences.get(f.experience_id);
    if (!exp) continue;
    const g = groups.get(exp.id) ?? { experience_id: exp.id, experience_title: exp.title, claims: [], gaps: [] };
    groups.set(exp.id, g);
    const known = new Set(repos.listClaims(exp.id).map(c => c.text));
    if (f.new_fact && !known.has(f.new_fact) && g.claims.length < MAX_PER_EXPERIENCE) {
      g.claims.push(repos.addClaim({ experience_id: exp.id, text: f.new_fact, attribution: f.attribution, created_from: 'interview' }));
    }
    if (f.gap && !g.gaps.includes(f.gap) && g.gaps.length < MAX_PER_EXPERIENCE) g.gaps.push(f.gap);
  }
  return [...groups.values()].filter(g => g.claims.length || g.gaps.length);
}
