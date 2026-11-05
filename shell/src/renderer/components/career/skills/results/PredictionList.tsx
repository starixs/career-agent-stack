/**
 * 预测追问（probe-predict）的成果：简历里哪句话会被深挖、会怎么一层层问下去。
 * 高风险的排前面，最要紧的那条直接摊开当示范，其余点开再看——面试前一晚要的是最可能出事的那几条。
 */
import { Badge, type BadgeTone } from '../../CareerPrimitives';
import type { ProbePrediction } from '../../types';
import { parseJson, texts } from '../read';

import { Disclosure } from './parts';

interface RiskLevel { label: string; tone: BadgeTone; order: number }
const RISK_LEVELS: Record<string, RiskLevel> = {
  high: { label: '高风险', tone: 'error', order: 0 },
  // 提示词前后两版分别写成 mid 和 medium，是同一档
  mid: { label: '中风险', tone: 'warning', order: 1 },
  medium: { label: '中风险', tone: 'warning', order: 1 },
  low: { label: '低风险', tone: 'success', order: 2 },
};
const UNKNOWN_RISK: RiskLevel = { label: '未评级', tone: 'neutral', order: 3 };

const TARGET_LABELS: Record<string, string> = { data: '数字', project: '项目', industry: '行业判断', method: '方法' };

export function riskOf(prediction: Pick<ProbePrediction, 'risk'>): RiskLevel {
  return RISK_LEVELS[prediction.risk] ?? UNKNOWN_RISK;
}

/** 按风险从高到低排，同一档保持原来的先后。 */
export function sortByRisk<T extends Pick<ProbePrediction, 'risk'>>(predictions: T[]): T[] {
  return [...predictions].sort((a, b) => riskOf(a).order - riskOf(b).order);
}

/** 「高风险 10 · 中风险 1 · 低风险 5」。 */
export function riskSummary(predictions: Array<Pick<ProbePrediction, 'risk'>>): string {
  const counts = new Map<string, number>();
  for (const prediction of sortByRisk(predictions)) {
    const { label } = riskOf(prediction);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} ${n}`).join(' · ');
}

function Chain({ steps }: { steps: string[] }) {
  if (steps.length === 0) return <div className="text-xs text-[var(--subtle)]">这一条还没有追问链</div>;
  return (
    <ol className="space-y-2 border-l border-[var(--line-2)] pl-4">
      {steps.map((step, index) => (
        <li key={`${index}:${step}`} className="flex gap-2 text-sm leading-relaxed text-[var(--ink-2)]">
          <span className="w-4 shrink-0 text-xs tabular-nums leading-6 text-[var(--subtle)]">{index + 1}</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function PredictionList({ predictions }: { predictions: ProbePrediction[] }) {
  return (
    <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
      {sortByRisk(predictions).map((prediction, index) => {
        const risk = riskOf(prediction);
        return (
          <Disclosure
            key={prediction.id}
            defaultOpen={index === 0}
            summary={(
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <Badge tone={risk.tone}>{risk.label}</Badge>
                  <span className="text-xs text-[var(--muted)]">{TARGET_LABELS[prediction.target_type] ?? prediction.target_type}</span>
                </span>
                <span className="text-sm leading-relaxed text-[var(--ink)]">{prediction.statement}</span>
              </span>
            )}
          >
            <Chain steps={texts(parseJson(prediction.expected_chain_json, `probe_prediction ${prediction.id}.expected_chain_json`))} />
          </Disclosure>
        );
      })}
    </div>
  );
}
