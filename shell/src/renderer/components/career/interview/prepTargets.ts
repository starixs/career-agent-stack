/**
 * 面试助力「准备哪一场」的候选：还没复盘的面试排前面（最近要面的那场最先），后面是投过的岗位。
 * 也决定一进来先看哪个页签：有面完还没复盘的、又没有马上要面的，就先看复盘。
 */
import { INTERVIEW_ROUND_LABELS } from '../careerConstants';
import type { DossierSummary, Interview } from '../types';

export interface PrepTarget {
  /** `itv:<面试 id>` 或 `app:<投递 id>`。 */
  key: string;
  /** 下拉里的一行：公司 · 轮次 · 日期，或 公司 · 岗位。 */
  label: string;
  company: string | null;
  title: string | null;
  /** 面试时间；还没约时间的投递为空。 */
  at: string | null;
  /** 发进对话时带上的对象 id，助理不用再问「哪一场」。 */
  refs: { application_id?: string; job_id?: string; interview_id?: string };
  round?: string;
}

export type WorkbenchTab = 'prep' | 'retro' | 'bank';

function whenLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 按天比：库里的面试时间有的只有日期、有的带时刻；当天的面试算「还没面」。 */
const day = (iso: string): string => iso.slice(0, 10);
const isUpcoming = (interview: Interview, nowIso: string): boolean => !interview.retro_json && !!interview.date && day(interview.date) >= day(nowIso);
const awaitsRetro = (interview: Interview, nowIso: string): boolean => !interview.retro_json && !!interview.date && day(interview.date) < day(nowIso);

function interviewTarget(interview: Interview, dossiers: DossierSummary[]): PrepTarget {
  const dossier = interview.application_id ? dossiers.find(d => d.application_id === interview.application_id) : undefined;
  const parts = [interview.company_name, INTERVIEW_ROUND_LABELS[interview.round] ?? interview.round, whenLabel(interview.date)];
  return {
    key: `itv:${interview.id}`, label: parts.filter(Boolean).join(' · '), company: interview.company_name, title: interview.title ?? dossier?.title ?? null,
    at: interview.date, round: interview.round,
    refs: { interview_id: interview.id, application_id: interview.application_id ?? undefined, job_id: dossier?.job_id },
  };
}

export function buildPrepTargets(interviews: Interview[], dossiers: DossierSummary[], nowIso = new Date().toISOString()): PrepTarget[] {
  const upcoming = interviews.filter(i => isUpcoming(i, nowIso)).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const scheduled = new Set(upcoming.map(i => i.application_id).filter(Boolean));
  const applications = dossiers.filter(d => !d.closed && !scheduled.has(d.application_id)).map(d => ({
    key: `app:${d.application_id}`, label: [d.company_name, d.title].filter(Boolean).join(' · '), company: d.company_name, title: d.title, at: null,
    refs: { application_id: d.application_id, job_id: d.job_id },
  }));
  return [...upcoming.map(i => interviewTarget(i, dossiers)), ...applications];
}

/** 一进来先看哪个页签。 */
export function suggestedTab(interviews: Interview[], nowIso = new Date().toISOString()): WorkbenchTab {
  const hasUpcoming = interviews.some(i => isUpcoming(i, nowIso));
  return !hasUpcoming && interviews.some(i => awaitsRetro(i, nowIso)) ? 'retro' : 'prep';
}
