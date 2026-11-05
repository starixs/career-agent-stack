/**
 * 功能发现（plan-r3-suggest §4.5）：每个功能什么时候起头。功能清单本身在 shared/careerFeatures.ts（与功能市场同源），
 * 这里只管"此刻用得上吗"。每轮最多 1 格起头（S26 例外：四格全是起头），出过的冷却 SEED_COOLDOWN 轮（L9）。
 */
import { FEATURE_IDS, type FeatureId } from '../../shared/careerFeatures';
import type { SuggestChip } from '../../shared/careerSuggest';
import { FEATURE_SEED_PREFIX, featureChip } from './suggest-chip';
import { EXAM_DUE_KINDS, INTERVIEW_DUE_KINDS, type SceneId, type SuggestInput } from './suggest-scene';
import { shortCompany } from './suggest-text';
import type { SuggestState } from './suggest-types';

export interface FeatureCtx { scene: SceneId; input: SuggestInput }

type When = (s: SuggestState, c: FeatureCtx) => boolean;

const LATER = ['first', 'batch', 'released'];
const later = (s: SuggestState) => LATER.includes(s.stage);
const in_ = (c: FeatureCtx, ...scenes: SceneId[]) => scenes.includes(c.scene);
const due = (s: SuggestState, kinds: readonly string[]) => s.dueSoon.some(d => kinds.includes(d.kind));
const running = (s: SuggestState) => s.batch?.status === 'running';

/** 每个功能的出现条件（id 集合必须与 FEATURE_IDS 一致，单测断言）。 */
export const FEATURE_WHEN: Readonly<Record<FeatureId, When>> = {
  batch: s => later(s) && s.resume.has && s.openCard?.kind !== 'batch_pick' && !running(s),
  live: s => running(s) || s.held.count > 0,
  job_evaluate: (s, c) => s.stage !== 'profile' && !c.input.lastTools.includes('job_evaluate'),
  company_research: s => s.stage !== 'profile',
  mail_bind: s => !s.mailConnected && ['profile', 'direction', 'first'].includes(s.stage),
  exam_search: (s, c) => due(s, EXAM_DUE_KINDS) || (in_(c, 'S26', 'S20') && later(s)),
  exam_practice: s => due(s, EXAM_DUE_KINDS),
  interview_prep: s => due(s, INTERVIEW_DUE_KINDS) && s.openCard?.kind !== 'interview_prep',
  interview_predict: s => due(s, INTERVIEW_DUE_KINDS),
  interview_probe: s => s.openCard?.kind === 'interview_prep',
  interview_retro: (s, c) => in_(c, 'S21', 'S22'),
  self_intro: (s, c) => in_(c, 'S21', 'S26') && later(s),
  open_q: s => s.asks.some(a => a.title.includes('开放题')),
  direction_explore: (s, c) => s.stage !== 'profile' && in_(c, 'S24', 'S28', 'S9', 'S26'),
  offer: (s, c) => in_(c, 'S23'),
  funnel: (s, c) => later(s) && in_(c, 'S24', 'S26'),
  resume_editor: (s, c) => s.resume.has && in_(c, 'S7', 'S11', 'S26'),
  phone_link: s => !s.phoneLinked && s.asks.some(a => a.kind === 'login'),
  mail_compose: () => false,
  interview: (s, c) => in_(c, 'S26') && due(s, INTERVIEW_DUE_KINDS),
};

/** 挑起头时的先后：此刻最可能用上的在前（S26 按这个顺序取四个）。 */
export const FEATURE_PRIORITY: readonly FeatureId[] = [
  'phone_link', 'interview_prep', 'exam_search', 'open_q', 'batch', 'live', 'mail_bind', 'company_research',
  'interview_predict', 'interview_probe', 'exam_practice', 'self_intro', 'funnel', 'direction_explore',
  'job_evaluate', 'resume_editor', 'interview_retro', 'offer', 'interview', 'mail_compose',
];

/** 起头格里要点名的公司：截止那家 > 下一批第一家。 */
export function featureCompany(s: SuggestState, id: FeatureId): string | null {
  const dueKinds = id.startsWith('exam') ? EXAM_DUE_KINDS : INTERVIEW_DUE_KINDS;
  const d = s.dueSoon.find(x => dueKinds.includes(x.kind));
  if (d && (id.startsWith('exam') || id.startsWith('interview'))) return shortCompany(d.company);
  if (id === 'interview_probe' && s.openCard?.company) return shortCompany(s.openCard.company);
  if (id === 'company_research' && s.nextJobs[0]) return shortCompany(s.nextJobs[0].company);
  return null;
}

/** 此刻可起头的功能格，按先后排；recent 里的（冷却中）不出，S26 不冷却。 */
export function featureChips(s: SuggestState, c: FeatureCtx, recent: ReadonlySet<string>, max: number): SuggestChip[] {
  const cools = c.scene !== 'S26';
  return FEATURE_PRIORITY
    .filter(id => FEATURE_WHEN[id](s, c) && !(cools && recent.has(`${FEATURE_SEED_PREFIX}${id}`)))
    .slice(0, max)
    .map(id => featureChip(id, featureCompany(s, id)));
}

/** 单测用：两表 id 集合一致。 */
export const FEATURE_WHEN_IDS: readonly FeatureId[] = FEATURE_IDS.filter(id => id in FEATURE_WHEN);
