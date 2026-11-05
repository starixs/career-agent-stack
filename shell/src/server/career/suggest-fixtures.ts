/**
 * 下一步条单测共用的状态夹具（只给 suggest*.unit.test.ts 用）：纯对象，状态从哪来见 suggest-state.unit.test.ts。
 */
import type { SuggestRequest } from '../../shared/careerSuggest';
import { inputOf, type SuggestInput } from './suggest-scene';
import type { SuggestAsk, SuggestCard, SuggestInterview, SuggestState } from './suggest-types';

export const state = (over: Partial<SuggestState> = {}): SuggestState => ({
  stage: 'batch', asks: [], openCard: null, batch: null, held: { count: 0, companies: [], askId: null },
  nextJobs: [], pool: { fits: 0, total: 0, outsourced: 0 },
  prefs: { keywords: ['财务', '运营'], cities: [], cohort: '2027' },
  resume: { has: true, name: '财务版', tailored: 0, experiences: 3 },
  mailConnected: true, phoneLinked: true, lastTailor: null, todaySent: 0, awayHours: 0, hour: 15, cohortGuess: 2027,
  interview: null, dueSoon: [], rejections7d: 0, askOptions: {},
  ...over,
});

export const ask = (over: Partial<SuggestAsk> & Pick<SuggestAsk, 'kind'>): SuggestAsk =>
  ({ id: `ask-${over.kind}`, title: '', companies: [], count: 1, ...over });

export const card = (over: Partial<SuggestCard> & Pick<SuggestCard, 'kind'>): SuggestCard =>
  ({ id: `card-${over.kind}`, picked: [], pickedIds: [], allIds: [], more: 0, company: null, ...over });

export const jobs = (...companies: string[]) => companies.map((company, i) => ({ job_id: `job-${i}`, company, known: true }));

export const interview = (over: Partial<SuggestInterview> = {}): SuggestInterview =>
  ({ round: 'course_project', inProgress: true, experienceTitle: '数据库课设', followUps: ['几个人一组？'], roundsTodo: ['internship', 'campus'], ...over });

/** 访谈中、还没简历的状态。 */
export const interviewing = (over: Partial<SuggestInterview> = {}, s: Partial<SuggestState> = {}): SuggestState => state({
  stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 1 }, interview: interview(over), ...s,
});

export const input = (req: SuggestRequest = {}): SuggestInput => inputOf(req);
