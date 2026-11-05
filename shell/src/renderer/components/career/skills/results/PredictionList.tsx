/**
 * 预测追问（probe-predict）的成果：简历里哪句话会被深挖、会被追到第几层。
 * 每条左边一道风险色、下面一排圆点表示追问有几层；点开才看一层层会怎么问。风险高的排前面。
 */
import { useState } from 'react';

import type { ProbePrediction } from '../../types';
import { parseJson, texts } from '../read';
import { Pips, toneColor, type Segment, type Tone } from '../visual';

interface RiskLevel { label: string; tone: Tone; order: number }
const RISK_LEVELS: Record<string, RiskLevel> = {
  high: { label: '高风险', tone: 'danger', order: 0 },
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

/** 高、中、低各几条，给分段条用。 */
export function riskSegments(predictions: Array<Pick<ProbePrediction, 'risk'>>): Segment[] {
  const counts = new Map<string, Segment>();
  for (const prediction of sortByRisk(predictions)) {
    const { label, tone } = riskOf(prediction);
    const current = counts.get(label);
    counts.set(label, { label, tone, value: (current?.value ?? 0) + 1 });
  }
  return [...counts.values()];
}

function PredictionCard({ prediction }: { prediction: ProbePrediction }) {
  const [open, setOpen] = useState(false);
  const risk = riskOf(prediction);
  const chain = texts(parseJson(prediction.expected_chain_json, `probe_prediction ${prediction.id}.expected_chain_json`));
  return (
    <li>
      <button
        type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full gap-3 rounded-md py-2.5 pr-2 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <span className="w-1 shrink-0 self-stretch rounded-full" style={{ background: toneColor(risk.tone) }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block text-sm leading-relaxed text-[var(--ink)] ${open ? '' : 'line-clamp-2'}`}>{prediction.statement}</span>
          <span className="mt-1.5 flex items-center gap-2 text-xs text-[var(--muted)]">
            <span style={{ color: toneColor(risk.tone) }}>{risk.label}</span>
            <span>{TARGET_LABELS[prediction.target_type] ?? prediction.target_type}</span>
            {chain.length > 0 && <Pips total={chain.length} reached={chain.length} label={`会追问 ${chain.length} 层`} />}
          </span>
        </span>
      </button>
      {open && chain.length > 0 && (
        <ol className="mb-3 ml-4 space-y-2 border-l border-dashed border-[var(--line-2)] pl-4">
          {chain.map((step, index) => (
            <li key={`${index}:${step}`} className="relative text-sm leading-relaxed text-[var(--ink-2)]">
              <span className="absolute -left-[21px] top-2 h-2 w-2 rounded-full border-[1.5px] border-[var(--hard)] bg-[var(--paper)]" aria-hidden />
              {step}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function PredictionList({ predictions }: { predictions: ProbePrediction[] }) {
  return (
    <ul className="divide-y divide-[var(--line)]">
      {sortByRisk(predictions).map(prediction => <PredictionCard key={prediction.id} prediction={prediction} />)}
    </ul>
  );
}
