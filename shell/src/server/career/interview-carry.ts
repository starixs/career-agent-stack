/**
 * 复盘回流到下一场：准备一场面试时，带上「上一场同类面试」复盘出的卡点。
 * - 同一份申请的前几轮：一定带（下一轮的面试官往往接着上一轮问）；
 * - 别家的同类面试：岗位类别相同（classifyJobTitle）且轮次相同，取最近一场；
 * - 低分题：那几场里被问到、还没练过或最近得分低于 60 的原题。
 * 只读已有记录，不调模型；拼成一段提示词交给出题 / 模拟 / 预测。
 */
import { classifyJobTitle, type Interview, type Job, type Repos } from '@career/core';

import { normalizeRoundLabel } from './interview-link';
import type { CareerStore } from './store';

/** 每类最多带几场、几道题：前一晚的准备要的是最可能出事的少数几条，不是全部历史。 */
const MAX_OTHER_INTERVIEWS = 1;
const MAX_WEAK_QUESTIONS = 5;

export interface CarriedRetro {
  interview_id: string; company: string | null; round: string; same_application: boolean;
  focus: string | null; next_round_probes: string[];
}
export interface Carryover { retros: CarriedRetro[]; weak_questions: string[] }

function retroOf(itv: Interview): { focus: string | null; probes: string[] } | null {
  if (!itv.retro_json) return null;
  try {
    const r: unknown = JSON.parse(itv.retro_json);
    if (!r || typeof r !== 'object') return null;
    const rawProbes: unknown = Reflect.get(r, 'next_round_probes');
    const rawFocus: unknown = Reflect.get(r, 'focus_this_round');
    const probes = Array.isArray(rawProbes) ? rawProbes.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
    return { focus: typeof rawFocus === 'string' && rawFocus.trim() ? rawFocus : null, probes };
  } catch (error) {
    console.warn(`[career] carryover: retro_json 不是 JSON interview=${itv.id}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** 这份岗位（这一轮）准备时该带上的复盘与低分题。 */
export function carryoverFor(store: CareerStore, repos: Repos, job: Job, round?: string | null): Carryover {
  const appIds = new Set(repos.listApplications().filter(a => a.job_id === job.id).map(a => a.id));
  const category = classifyJobTitle(job.title);
  const normalized = round ? normalizeRoundLabel(round) : null;
  const want = normalized && normalized !== 'other' ? normalized : null;
  const reviewed = store.listInterviews().filter(i => i.retro_json);
  const own = reviewed.filter(i => i.application_id && appIds.has(i.application_id));
  const others = reviewed
    .filter(i => !(i.application_id && appIds.has(i.application_id)))
    .filter(i => classifyJobTitle(i.title ?? (i.application_id ? repos.getJob(repos.getApplication(i.application_id)?.job_id ?? '')?.title : null)) === category)
    .filter(i => !want || i.round === want)
    .slice(0, MAX_OTHER_INTERVIEWS);
  const retros = [...own.map(i => [i, true] as const), ...others.map(i => [i, false] as const)].flatMap(([i, same]) => {
    const r = retroOf(i);
    return r && (r.focus || r.probes.length) ? [{ interview_id: i.id, company: i.company_name, round: i.round, same_application: same, focus: r.focus, next_round_probes: r.probes }] : [];
  });
  const companies = [...new Set([...own, ...others].map(i => i.company_name).filter((c): c is string => !!c))];
  const weak = companies.flatMap(company => repos.listQuestions({ source: 'seen', company, weak_only: true, limit: MAX_WEAK_QUESTIONS }).map(q => q.content));
  return { retros, weak_questions: [...new Set(weak)].slice(0, MAX_WEAK_QUESTIONS) };
}

/** 拼进提示词的一段；什么都没有时返回空串。 */
export function carryoverPrompt(c: Carryover): string {
  if (!c.retros.length && !c.weak_questions.length) return '';
  const lines = c.retros.map(r => `- ${r.same_application ? '这份申请的上一轮' : `同类面试（${r.company ?? '别家'}）`} ${r.round}：${[r.focus, ...r.next_round_probes].filter(Boolean).join('；')}`);
  const weak = c.weak_questions.map(q => `- ${q}`);
  return ['上一场同类面试复盘出的卡点（务必覆盖，优先追问这些）：', ...lines, ...(weak.length ? ['当时答得不好、还没练好的原题：', ...weak] : [])].join('\n');
}

/** 一场模拟面试存下的最新问答全文（turns_json 里最后一条 transcript）；没有返回 undefined。 */
export function lastTranscript(mock: { id: string; turns_json: string }): string | undefined {
  try {
    const turns: unknown = JSON.parse(mock.turns_json);
    if (!Array.isArray(turns)) return undefined;
    const texts = turns.map((t: unknown) => (t && typeof t === 'object' ? Reflect.get(t, 'transcript') : null)).filter((t): t is string => typeof t === 'string' && !!t);
    return texts.at(-1);
  } catch (error) {
    console.warn(`[career] mock turns_json 不是 JSON mock=${mock.id}:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}
