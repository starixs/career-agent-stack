/**
 * 功能市场要摆出来的真东西：每个工作台卡片上放一小块它里面的真实内容，技能点旁边放做过几次。
 * 每一项各取各的：某一项取不到只是那张卡少一块内容，不拖累整页。
 */
import { careerApi } from '../careerApi';
import type { Company, DossierSummary, MonthBoard, Offer, ProbePrediction, ResumeMaster } from '../types';
import { useCareerQuery } from '../useCareerData';

export interface MarketData {
  predictions: ProbePrediction[]; mocks: number; companies: Company[]; offers: Offer[]; dossiers: DossierSummary[];
  board: MonthBoard | null; resume: ResumeMaster | null;
  /** 技能点做过几次：技能点 id → 条数。 */
  done: Record<string, number>;
}

export const EMPTY_MARKET: MarketData = { predictions: [], mocks: 0, companies: [], offers: [], dossiers: [], board: null, resume: null, done: {} };

/** 取一样东西；取不到记一笔、用空值顶上（那张卡就少一块内容）。 */
async function take<T>(what: string, load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.warn(`[career-skills] 功能市场取「${what}」失败：`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

async function loadMarket(): Promise<MarketData> {
  const [predictions, mocks, companies, offers, dossiers, board, resumes, evaluations, directions, gapPlans, materials] = await Promise.all([
    take('追问预测', careerApi.probePredictions, []), take('模拟面试', careerApi.mockInterviews, []), take('公司调研', careerApi.companies, []),
    take('Offer', careerApi.offers, []), take('投递', careerApi.dossiers, []),
    take('求职月', async () => (await careerApi.review()).board, null),
    take('简历', careerApi.resumes, { masters: [], tailored: [] }),
    take('岗位评估', careerApi.jobEvaluations, []), take('方向', careerApi.directions, []),
    take('差距计划', careerApi.gapPlans, []), take('素材', () => careerApi.materials(), []),
  ]);
  return {
    predictions, mocks: mocks.length, companies, offers, dossiers, board, resume: resumes.masters[0] ?? null,
    done: { 'job-evaluate': evaluations.length, 'direction-explore': directions.length, 'gap-plan': gapPlans.length, 'material-draft': materials.length, 'resume-tailor': resumes.tailored.length },
  };
}

const TABLES = ['probe_prediction', 'mock_interview', 'company', 'offer', 'job', 'direction', 'gap_plan', 'material', 'application', 'resume_master', 'resume_tailored'] as const;

export function useMarketData(): MarketData {
  return useCareerQuery(loadMarket, TABLES).data ?? EMPTY_MARKET;
}
