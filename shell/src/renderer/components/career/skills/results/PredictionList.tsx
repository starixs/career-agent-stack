/**
 * 预测追问（probe-predict）的成果：简历里哪句话会被深挖、会被追到第几层。
 * 左右两栏：左边是句子（一道风险色 + 一组深度格），右边是选中那句的追问阶梯。风险高的排前面。
 */
import { useState } from 'react';

import { Button } from '../../CareerPrimitives';
import type { ProbePrediction } from '../../types';
import { parseJson, texts } from '../read';
import { DepthBars, StepCircle, toneColor, type Tone } from '../visual';

interface RiskLevel { label: string; tone: Tone; order: number }
const RISK_LEVELS: Record<string, RiskLevel> = {
  high: { label: '高风险', tone: 'danger', order: 0 },
  // 提示词前后两版分别写成 mid 和 medium，是同一档
  mid: { label: '中风险', tone: 'warning', order: 1 },
  medium: { label: '中风险', tone: 'warning', order: 1 },
  low: { label: '低风险', tone: 'success', order: 2 },
};
const UNKNOWN_RISK: RiskLevel = { label: '未评级', tone: 'neutral', order: 3 };

export function riskOf(prediction: Pick<ProbePrediction, 'risk'>): RiskLevel {
  return RISK_LEVELS[prediction.risk] ?? UNKNOWN_RISK;
}

/** 按风险从高到低排，同一档保持原来的先后。 */
export function sortByRisk<T extends Pick<ProbePrediction, 'risk'>>(predictions: T[]): T[] {
  return [...predictions].sort((a, b) => riskOf(a).order - riskOf(b).order);
}

const chainOf = (prediction: ProbePrediction): string[] => texts(parseJson(prediction.expected_chain_json, `probe_prediction ${prediction.id}.expected_chain_json`));

/** 阶梯每下一层往里缩这么多像素；缩到第几层为止（再深也不再缩，免得挤出去）。 */
const STEP_INDENT_PX = 20;
const MAX_INDENT_STEPS = 5;

/** 左栏的一句话：左边一道风险色，右边一组深度格。选中的描墨线、带硬投影。 */
function ClaimTab({ prediction, selected, onPick }: { prediction: ProbePrediction; selected: boolean; onPick: () => void }) {
  const risk = riskOf(prediction);
  const depth = chainOf(prediction).length;
  return (
    <button
      type="button" role="tab" aria-selected={selected} onClick={onPick}
      className={`flex w-full items-stretch gap-3 rounded-lg border-[1.5px] p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected ? 'border-[var(--hard)] bg-[var(--paper)] shadow-hard' : 'border-transparent hover:bg-[var(--hover)]'}`}
    >
      <span className="w-1.5 shrink-0 rounded-full" style={{ background: toneColor(risk.tone) }} aria-hidden />
      <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-relaxed text-[var(--ink)]">{prediction.statement}</span>
      <span className="flex items-center"><DepthBars depth={depth} tone={risk.tone} label={depth > 0 ? `${risk.label}，会追问 ${depth} 层` : risk.label} /></span>
    </button>
  );
}

/** 右栏：这句话用荧光笔划出来，下面是一级级往里走的追问阶梯，最深的那一级描风险色。 */
function ProbeLadder({ prediction, onPractice }: { prediction: ProbePrediction; onPractice?: (prediction: ProbePrediction) => void }) {
  const risk = riskOf(prediction);
  const chain = chainOf(prediction);
  return (
    <div role="tabpanel" aria-label={prediction.statement} className="min-w-0 space-y-4">
      <p className="font-human text-lg font-semibold leading-relaxed text-[var(--ink)]">
        <mark className="box-decoration-clone rounded-sm bg-[var(--mark)] px-1 text-inherit">{prediction.statement}</mark>
      </p>
      <ol aria-label="会怎么追问" className="space-y-2">
        {chain.map((step, index) => (
          <li key={`${index}:${step}`} className="flex items-start gap-2.5" style={{ marginLeft: Math.min(index, MAX_INDENT_STEPS) * STEP_INDENT_PX }}>
            <StepCircle n={index + 1} />
            <span
              className="min-w-0 rounded-lg rounded-tl-sm border-[1.5px] bg-[var(--paper)] px-3 py-1.5 text-sm leading-relaxed text-[var(--ink)]"
              style={{ borderColor: index === chain.length - 1 ? toneColor(risk.tone) : 'var(--line)' }}
            >
              {step}
            </span>
          </li>
        ))}
      </ol>
      {onPractice && <Button size="sm" onClick={() => onPractice(prediction)}>练这一句</Button>}
    </div>
  );
}

/**
 * 两栏：左边是简历里会被深挖的句子（风险高的在前），右边是选中那句的追问阶梯。
 * 风险只用颜色说（红 / 橙 / 绿），深度用一组格子说，不再写「高风险」「追问 5 层」这些字。
 */
export function PredictionList({ predictions, onPractice }: { predictions: ProbePrediction[]; onPractice?: (prediction: ProbePrediction) => void }) {
  const sorted = sortByRisk(predictions);
  const [picked, setPicked] = useState<string | null>(null);
  const active = sorted.find(prediction => prediction.id === picked) ?? sorted[0];
  if (!active) return null;
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div role="tablist" aria-label="会被深挖的句子" aria-orientation="vertical" className="space-y-1">
        {sorted.map(prediction => <ClaimTab key={prediction.id} prediction={prediction} selected={prediction.id === active.id} onPick={() => setPicked(prediction.id)} />)}
      </div>
      <ProbeLadder prediction={active} onPractice={onPractice} />
    </div>
  );
}
