/**
 * 面试助力工作台：围绕五个面试技能做的一整页（功能市场 › 工作台）。
 *  - 准备：预测追问 → 先练几道 → 模拟一场 → 讲一遍项目（components/career/interview/PrepTab）
 *  - 复盘：每一场真实面试的记录，面完说几句就复盘（RetroTab）
 *  - 题库：见过的题、按岗位出的题、每道题练得怎样（QuestionBankPanel）
 * 一进来先看哪个页签由数据决定：有面完还没复盘的、又没有马上要面的，先看复盘。
 */
import { useMemo, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { ErrorRow, LoadingRow } from '@/components/career/CareerPrimitives';
import { PrepTab, type PrepData } from '@/components/career/interview/PrepTab';
import { suggestedTab, type WorkbenchTab } from '@/components/career/interview/prepTargets';
import { RetroTab } from '@/components/career/interview/RetroTab';
import { QuestionBankPanel } from '@/components/career/QuestionBankPanel';
import { useCareerQuery } from '@/components/career/useCareerData';

async function loadAll(): Promise<PrepData> {
  const [interviews, mocks, predictions, dossiers, questions] = await Promise.all([
    careerApi.interviews(), careerApi.mockInterviews(), careerApi.probePredictions(), careerApi.dossiers(), careerApi.questions({ kind: 'interview' }),
  ]);
  return { interviews, mocks, predictions, dossiers, questions };
}

const TABS: ReadonlyArray<{ id: WorkbenchTab; label: string }> = [
  { id: 'prep', label: '准备' }, { id: 'retro', label: '复盘' }, { id: 'bank', label: '题库' },
];
const TABLES = ['interview', 'mock_interview', 'probe_prediction', 'application', 'question'] as const;

function TabBar({ tab, onChange }: { tab: WorkbenchTab; onChange: (tab: WorkbenchTab) => void }) {
  return (
    <div role="tablist" aria-label="面试助力" className="flex gap-1 text-sm">
      {TABS.map(({ id, label }) => (
        <button
          key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onChange(id)}
          className={`rounded-md px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${tab === id ? 'bg-[var(--hover)] font-semibold text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function CareerInterview() {
  const query = useCareerQuery(loadAll, TABLES);
  const data = query.data;
  const interviews = useMemo(
    () => [...(data?.interviews ?? [])].sort((a, b) => ((b.date ?? b.created_at) > (a.date ?? a.created_at) ? 1 : -1)),
    [data],
  );
  // 手动点过页签就听他的；没点过按数据建议
  const [picked, setPicked] = useState<WorkbenchTab | null>(null);
  const tab = picked ?? suggestedTab(interviews);

  return (
    <div className="space-y-6 px-6 py-5">
      <TabBar tab={tab} onChange={setPicked} />
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !data && <LoadingRow />}
      {data && tab === 'prep' && <PrepTab data={data} onOpenBank={() => setPicked('bank')} />}
      {data && tab === 'retro' && <RetroTab interviews={interviews} onChanged={query.reload} />}
      {tab === 'bank' && <QuestionBankPanel />}
    </div>
  );
}
