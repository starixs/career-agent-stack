/**
 * 功能市场卡片上的真实计数：「查过 29 家」「16 条预测」。只用库里的真数，没有就不显示。
 * 每一项各取各的：某一项取不到只少一行字，不拖累整页。
 */
import { careerApi } from '../careerApi';
import { useCareerQuery } from '../useCareerData';

export type MarketCounts = Partial<Record<string, string>>;

/** 取一个列表的条数；取不到记一笔、当作 0（卡片上就不显示这一行）。 */
async function countOf(what: string, load: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await load()).length;
  } catch (error) {
    console.warn(`[career-skills] 功能市场取「${what}」的条数失败：`, error instanceof Error ? error.message : error);
    return 0;
  }
}

const join = (parts: Array<string | false>): string | undefined => parts.filter(Boolean).join(' · ') || undefined;

async function loadCounts(): Promise<MarketCounts> {
  const [predictions, mocks, companies, offers, evaluations, directions, gapPlans, materials, applied] = await Promise.all([
    countOf('追问预测', careerApi.probePredictions), countOf('模拟面试', careerApi.mockInterviews), countOf('公司调研', careerApi.companies),
    countOf('Offer', careerApi.offers), countOf('岗位评估', careerApi.jobEvaluations), countOf('方向', careerApi.directions),
    countOf('差距计划', careerApi.gapPlans), countOf('素材', () => careerApi.materials()),
    countOf('投递', async () => (await careerApi.dossiers()).filter(row => !!row.applied_at)),
  ]);
  return {
    interview: join([predictions > 0 && `${predictions} 条预测`, mocks > 0 && `${mocks} 场模拟`]),
    company: join([companies > 0 && `查过 ${companies} 家`]),
    offer: join([offers > 0 && `${offers} 个`]),
    apply: join([applied > 0 && `投出 ${applied} 家`]),
    'job-evaluate': join([evaluations > 0 && `${evaluations} 个`]),
    'direction-explore': join([directions > 0 && `${directions} 个`]),
    'gap-plan': join([gapPlans > 0 && `${gapPlans} 份`]),
    'material-draft': join([materials > 0 && `${materials} 篇`]),
  };
}

const TABLES = ['probe_prediction', 'mock_interview', 'company', 'offer', 'job', 'direction', 'gap_plan', 'material', 'application'] as const;

export function useMarketCounts(): MarketCounts {
  return useCareerQuery(loadCounts, TABLES).data ?? {};
}
