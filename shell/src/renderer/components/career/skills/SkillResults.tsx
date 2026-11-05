/**
 * 技能点详情里的「成果」：这个技能落了库的结果，用它自己的样子摆出来（不是把 JSON 倒出来）。
 * 一条都没有时什么都不渲染——上面的「开始」已经是下一步，不再放一句空话。
 */
import type { ReactNode } from 'react';

import { careerApi } from '../careerApi';
import { ErrorRow } from '../CareerPrimitives';
import { useCareerQuery } from '../useCareerData';

import type { ResultKind } from './catalog';
import { DirectionList } from './results/DirectionList';
import { GapPlans } from './results/GapPlans';
import { JobScores } from './results/JobScores';
import { MaterialList } from './results/MaterialList';

function Evaluations() {
  const query = useCareerQuery(careerApi.jobEvaluations, ['job']);
  if (query.error) return <ErrorRow message={query.error} onRetry={query.reload} />;
  return query.data?.length ? <JobScores evaluations={query.data} /> : null;
}

function Directions() {
  const query = useCareerQuery(careerApi.directions, ['direction']);
  if (query.error) return <ErrorRow message={query.error} onRetry={query.reload} />;
  return query.data?.length ? <DirectionList directions={query.data} onChanged={query.reload} /> : null;
}

async function loadGapPlans() {
  const [plans, directions, dossiers] = await Promise.all([careerApi.gapPlans(), careerApi.directions(), careerApi.dossiers()]);
  return { plans, targets: { directions, jobs: dossiers.map(d => ({ job_id: d.job_id, company_name: d.company_name, title: d.title })) } };
}

function Gaps() {
  const query = useCareerQuery(loadGapPlans, ['gap_plan', 'direction', 'application']);
  if (query.error) return <ErrorRow message={query.error} onRetry={query.reload} />;
  return query.data?.plans.length ? <GapPlans plans={query.data.plans} targets={query.data.targets} /> : null;
}

function Materials() {
  const query = useCareerQuery(() => careerApi.materials(), ['material']);
  if (query.error) return <ErrorRow message={query.error} onRetry={query.reload} />;
  return query.data?.length ? <MaterialList materials={query.data} /> : null;
}

const RESULTS: Record<ResultKind, () => ReactNode> = {
  evaluations: Evaluations, directions: Directions, gapPlans: Gaps, materials: Materials,
};

export function SkillResults({ kind }: { kind: ResultKind }) {
  const View = RESULTS[kind];
  return <View />;
}
