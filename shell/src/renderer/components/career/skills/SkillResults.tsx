/**
 * 技能点详情里的「成果」：这个技能做出来的东西，用它自己的样子摆出来（不是把 JSON 倒出来）。
 * 他还一条都没有时，用 samples/ 里的示例按同一个样子摆一份，左上角一枚「示例」章；他一有自己的，示例整块换掉。
 * 按岗位改简历、招呼语没有单独的成果页：改简历用对话里那张改动对照卡，招呼语用和通知中心同一个原文块。
 */
import type { ReactNode } from 'react';

import { careerApi } from '../careerApi';
import { ErrorRow } from '../CareerPrimitives';
import { TailorDiffCard } from '../ResumeChainCards';
import { useCareerQuery, type CareerQueryState } from '../useCareerData';

import type { SkillPointId } from './catalog';
import { DirectionList } from './results/DirectionList';
import { GapPlans } from './results/GapPlans';
import { GreetingList, greetingRows } from './results/GreetingList';
import { JobScores } from './results/JobScores';
import { MaterialList } from './results/MaterialList';
import { TriageList, triageRows } from './results/TriageList';
import { SAMPLE_DIRECTIONS } from './samples/direction';
import { SAMPLE_EVALUATIONS } from './samples/evaluate';
import { SAMPLE_GAP_PLANS, SAMPLE_GAP_TARGETS } from './samples/gap';
import { SAMPLE_GREETINGS } from './samples/greeting';
import { SAMPLE_MATERIALS } from './samples/material';
import { SampleFrame } from './samples/SampleFrame';
import { SAMPLE_TAILOR_CARD } from './samples/tailor';
import { SAMPLE_TRIAGE } from './samples/triage';

/** 回音最多摆这么多封：看的是「最近认出来了什么」，不是收件箱。 */
const TRIAGE_LIMIT = 8;
const noop = (): void => undefined;

/** 出错给重试；还在读不摆东西（免得示例先闪一下）；读回来是空的摆示例，否则摆他自己的。 */
function resultOrSample<T>(query: CareerQueryState<T>, empty: (data: T) => boolean, real: (data: T) => ReactNode, sample: ReactNode): ReactNode {
  if (query.error) return <ErrorRow message={query.error} onRetry={query.reload} />;
  if (query.data === null) return null;
  return empty(query.data) ? <SampleFrame>{sample}</SampleFrame> : real(query.data);
}

function Evaluations() {
  const query = useCareerQuery(careerApi.jobEvaluations, ['job']);
  return resultOrSample(query, data => data.length === 0, data => <JobScores evaluations={data} />, <JobScores evaluations={SAMPLE_EVALUATIONS} openFirst />);
}

function Directions() {
  const query = useCareerQuery(careerApi.directions, ['direction']);
  return resultOrSample(query, data => data.length === 0, data => <DirectionList directions={data} onChanged={query.reload} />, <DirectionList directions={SAMPLE_DIRECTIONS} onChanged={noop} />);
}

async function loadGapPlans() {
  const [plans, directions, dossiers] = await Promise.all([careerApi.gapPlans(), careerApi.directions(), careerApi.dossiers()]);
  return { plans, targets: { directions, jobs: dossiers.map(d => ({ job_id: d.job_id, company_name: d.company_name, title: d.title })) } };
}

function Gaps() {
  const query = useCareerQuery(loadGapPlans, ['gap_plan', 'direction', 'application']);
  return resultOrSample(query, data => data.plans.length === 0, data => <GapPlans plans={data.plans} targets={data.targets} />, <GapPlans plans={SAMPLE_GAP_PLANS} targets={SAMPLE_GAP_TARGETS} />);
}

function Materials() {
  const query = useCareerQuery(() => careerApi.materials(), ['material']);
  return resultOrSample(query, data => data.length === 0, data => <MaterialList materials={data} />, <MaterialList materials={SAMPLE_MATERIALS} openFirst />);
}

/** 改过的简历只存了整份，没存逐条改动：他改过之后这里不再摆示例，改动对照在当时的对话卡里。 */
function Tailors() {
  const query = useCareerQuery(careerApi.resumes, ['resume_tailored']);
  return resultOrSample(query, data => data.tailored.length === 0, () => null, <div className="max-w-2xl"><TailorDiffCard card={SAMPLE_TAILOR_CARD} onDone={noop} onDismiss={noop} /></div>);
}

async function loadGreetings() {
  const [pending, manual, dossiers] = await Promise.all([careerApi.pendingActions(), careerApi.actionsNeedingUser(), careerApi.dossiers()]);
  return greetingRows([...manual, ...pending], dossiers);
}

function Greetings() {
  const query = useCareerQuery(loadGreetings, ['action_queue', 'application']);
  return resultOrSample(query, data => data.length === 0, data => <GreetingList rows={data} onSent={query.reload} />, <GreetingList rows={SAMPLE_GREETINGS} onSent={noop} />);
}

async function loadTriage() {
  const [messages, dossiers] = await Promise.all([careerApi.mailMessages({ direction: 'in', relevance: 'job' }), careerApi.dossiers()]);
  return triageRows(messages, dossiers).slice(0, TRIAGE_LIMIT);
}

function Triage() {
  const query = useCareerQuery(loadTriage, ['mail_message', 'application']);
  return resultOrSample(query, data => data.length === 0, data => <TriageList rows={data} />, <TriageList rows={SAMPLE_TRIAGE} />);
}

const RESULTS: Partial<Record<SkillPointId, () => ReactNode>> = {
  'job-evaluate': Evaluations, 'direction-explore': Directions, 'gap-plan': Gaps, 'material-draft': Materials,
  'resume-tailor': Tailors, greeting: Greetings, 'inbox-triage': Triage,
};

export function SkillResults({ id }: { id: SkillPointId }) {
  const View = RESULTS[id];
  return View ? <View /> : null;
}
