/**
 * 投递状态步骤条的纯映射：ApplicationStage（packages/core/src/states.ts）→ 网申 → 测评 → 笔试 → 面试 → Offer → 入职。
 *
 * - 阶段里不区分测评 / 笔试：有对应的截止事件（deadline.kind = assessment / written_test）才算走到过；
 *   走过去了却没有记录的步骤标成 skipped（灰），不假装做过。
 * - 被拒 / 放弃 / 跳过：用阶段历史找到停在哪一步，那一步标 failed，后面的都是 todo。
 * - 颜色语义按 CAREER_DESIGN 6.1：被拒不用红色（failed 用中性色），需要你 = warning，笔试 / 测评 / 面试 = 钢笔蓝，Offer / 入职 = success。
 */
import type { ApplicationStage } from './types';

export type StepKey = 'apply' | 'assessment' | 'written' | 'interview' | 'offer' | 'hired';
export type StepState = 'done' | 'current' | 'failed' | 'skipped' | 'todo';
export type StepTone = 'neutral' | 'info' | 'accent' | 'warning' | 'success';

export const APPLICATION_STEPS: ReadonlyArray<{ key: StepKey; label: string }> = [
  { key: 'apply', label: '网申' },
  { key: 'assessment', label: '测评' },
  { key: 'written', label: '笔试' },
  { key: 'interview', label: '面试' },
  { key: 'offer', label: 'Offer' },
  { key: 'hired', label: '入职' },
];

const APPLY = 0, ASSESSMENT = 1, WRITTEN = 2, INTERVIEW = 3, OFFER = 4, HIRED = 5;

export interface StepperInput {
  stage: ApplicationStage;
  /** 阶段历史里到过的阶段（DossierSummary.reached_stages）。 */
  reached_stages?: readonly string[];
  /** 有过的测评 / 笔试安排（DossierSummary.exam_kinds）。 */
  exam_kinds?: ReadonlyArray<'assessment' | 'written_test'>;
  interview_count?: number;
}

export interface StepperModel {
  steps: Array<{ key: StepKey; label: string; state: StepState }>;
  /** 当前 / 停下的那一步。 */
  currentIndex: number;
  /** 当前那一步的状态色。 */
  tone: StepTone;
  /** 行内短标签，如「面试」「网申 · 需要你」「笔试 · 未通过」。 */
  label: string;
}

const TERMINAL_STOPPED: ReadonlySet<string> = new Set(['rejected', 'discarded', 'skip']);
const SUBMITTED: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);

/** 阶段本身对应到哪一步（不含测评 / 笔试，它们靠截止事件判断）。 */
function stageStep(stage: string): number {
  switch (stage) {
    case 'interview': return INTERVIEW;
    case 'offer': return OFFER;
    case 'hired': return HIRED;
    default: return APPLY;
  }
}

const SUFFIX: Partial<Record<ApplicationStage, string>> = {
  evaluated: '待投', ready: '待投', approved: '待投', pending: '投递中',
  blocked: '需要你', needs_user: '需要你', applied: '已投递', responded: '已回应',
  rejected: '未通过', discarded: '已放弃', skip: '跳过',
};

const TONE: Partial<Record<ApplicationStage, StepTone>> = {
  responded: 'info', interview: 'accent', offer: 'success', hired: 'success', blocked: 'warning', needs_user: 'warning',
};

export function applicationStepper(input: StepperInput): StepperModel {
  const { stage } = input;
  const reached = new Set<string>([...(input.reached_stages ?? []), stage]);
  const exams = new Set(input.exam_kinds ?? []);
  const submitted = [...reached].some(s => SUBMITTED.has(s));
  const interviewed = reached.has('interview') || (input.interview_count ?? 0) > 0;

  // 走到过的最远一步
  let furthest = Math.max(...[...reached].filter(s => !TERMINAL_STOPPED.has(s)).map(stageStep), APPLY);
  if (interviewed) furthest = Math.max(furthest, INTERVIEW);
  if (submitted && exams.has('assessment')) furthest = Math.max(furthest, ASSESSMENT);
  if (submitted && exams.has('written_test')) furthest = Math.max(furthest, WRITTEN);
  // 投出去之前被跳过 / 放弃：停在网申
  if (!submitted) furthest = APPLY;

  const observed = (i: number): boolean => {
    switch (i) {
      case APPLY: return submitted;
      case ASSESSMENT: return exams.has('assessment');
      case WRITTEN: return exams.has('written_test');
      case INTERVIEW: return interviewed;
      case OFFER: return reached.has('offer') || reached.has('hired');
      default: return reached.has('hired');
    }
  };

  const stopped = TERMINAL_STOPPED.has(stage);
  const hired = stage === 'hired';
  const steps = APPLICATION_STEPS.map((s, i) => {
    let state: StepState;
    if (i < furthest) state = observed(i) ? 'done' : 'skipped';
    else if (i > furthest) state = 'todo';
    else state = stopped ? 'failed' : hired ? 'done' : 'current';
    return { ...s, state };
  });

  const stepLabel = APPLICATION_STEPS[furthest].label;
  // 测评 / 笔试是当前要投入的一步（阶段仍是 applied / responded）
  const atExam = furthest === ASSESSMENT || furthest === WRITTEN;
  const suffix = hired ? null : atExam && !stopped ? null : SUFFIX[stage] ?? null;
  const label = hired ? '已入职' : suffix ? `${stepLabel} · ${suffix}` : stepLabel;
  const tone: StepTone = stopped ? 'neutral' : atExam ? 'accent' : TONE[stage] ?? 'neutral';
  return { steps, currentIndex: furthest, tone, label };
}
