/**
 * 一键开始：把一个技能要的东西（岗位 / 公司 / 题目类型）做成选择，选好点一下就发进对话。
 * 对象 id 走隐藏上下文，助理不用再问「哪一个」；用户全程不用打字（立场 9）。
 */
import { useState } from 'react';

import { careerApi } from '../careerApi';
import { STAGE_LABELS } from '../careerConstants';
import { Button, Select, useSuggestToChat } from '../CareerPrimitives';
import { useCareerQuery } from '../useCareerData';

import type { StartPick, StartSpec } from './catalog';
import { PickBox, type PickOption } from './PickBox';

/** 岗位库里一次最多带回这么多条候选。 */
const JOB_SEARCH_LIMIT = 8;

const jobLabel = (company: string | null | undefined, title: string): string => [company, title].filter(Boolean).join(' · ');

async function searchJobs(q: string): Promise<PickOption[]> {
  const { rows } = await careerApi.jobBoard({ q });
  return rows.slice(0, JOB_SEARCH_LIMIT).map(row => ({ id: row.job.id, label: jobLabel(row.job.company_name, row.job.title), hint: row.job.location ?? undefined }));
}

/** 他自己投过的岗位和公司：一点开就列出来。 */
export function useMyTargets(): { jobs: PickOption[]; companies: PickOption[] } {
  const dossiers = useCareerQuery(careerApi.dossiers, ['application', 'job']);
  const rows = dossiers.data ?? [];
  const jobs = rows.map(row => ({ id: row.job_id, label: jobLabel(row.company_name, row.title), hint: STAGE_LABELS[row.stage] ?? undefined }));
  const names = [...new Set(rows.map(row => row.company_name).filter((name): name is string => !!name))];
  return { jobs, companies: names.map(name => ({ id: null, label: name })) };
}

export function StartBar({ spec, surface }: { spec: StartSpec; surface: string }) {
  const suggest = useSuggestToChat();
  const targets = useMyTargets();
  const [job, setJob] = useState<PickOption | null>(null);
  const [company, setCompany] = useState<PickOption | null>(null);
  const [topic, setTopic] = useState(spec.topics?.[0]?.value ?? '');
  const needsJob = spec.inputs.includes('job');

  const start = () => {
    const pick: StartPick = { jobId: job?.id ?? undefined, jobLabel: job?.label, company: company?.label, topic: topic || undefined };
    suggest(spec.say(pick), { surface, refs: { job_id: pick.jobId } });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsJob && (
        <PickBox ariaLabel="岗位" placeholder="选一个岗位" value={job} onChange={setJob} options={targets.jobs} search={searchJobs} freeText className="w-80 max-w-full" />
      )}
      {spec.inputs.includes('topic') && spec.topics && (
        <div className="w-44"><Select ariaLabel="写哪一类" value={topic} onChange={setTopic} options={[...spec.topics]} /></div>
      )}
      {spec.inputs.includes('company') && (
        <PickBox ariaLabel="公司" placeholder="公司（可不填）" value={company} onChange={setCompany} options={targets.companies} freeText className="w-56 max-w-full" />
      )}
      <Button variant="primary" disabled={needsJob && !job} onClick={start}>{spec.label}</Button>
    </div>
  );
}
