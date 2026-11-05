/**
 * 追问卡：一句被追问的话一张卡，模拟报告和面后复盘共用。
 * 从上到下是一件事的四样东西，各用各的形状，不靠小标题区分：
 *   这句话（加粗）→ 追问轨道（走到第几站、红叉是卡住的那站）→ 面试官那边的看法（带人像的气泡；「也可能是」是虚线气泡）
 *   → 可以怎么答（便签；要先核实的事是便签里的空方框）。
 */
import { UserRound } from 'lucide-react';

import { pickText, texts, type Dict } from '../read';
import { DepthTrack } from '../visual';

/** 追问一般钻到五层左右（技能约定 4–6 层），轨道至少画这么多站。 */
const USUAL_DEPTH = 5;

/** 「可以这样答」：便签。要先核实的事是下面一排空方框——没核实前这句话还不能说。 */
export function AnswerNote({ answer, question }: { answer: Dict; question?: string | null }) {
  const verify = texts(answer.needs_verification);
  return (
    <div className="rounded-md bg-[var(--note)] px-3 py-2 text-sm leading-relaxed" role="note" aria-label="可以这样答">
      {question && <div className="text-xs text-[var(--muted)]">{question}</div>}
      <div className="text-[var(--ink)]">{pickText(answer, 'answer')}</div>
      {verify.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--warning)]">
          {verify.map((item, index) => (
            <li key={`${index}:${item}`} className="flex items-center gap-1.5" aria-label={`先核实：${item}`}>
              <span className="h-3 w-3 shrink-0 rounded-sm border-[1.5px] border-current" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ProbeCardProps {
  claim: string | null;
  /** 卡在第几层；0 表示没卡住。 */
  stuck: number;
  /** 看到的事实：哪里出了问题。 */
  issue?: string | null;
  /** 面试官那边会怎么想。 */
  thought?: string | null;
  /** 同一件事的另一种解释。 */
  alternative?: string | null;
  answer?: Dict;
}

export function ProbeCard({ claim, stuck, issue, thought, alternative, answer }: ProbeCardProps) {
  return (
    <li className="flex flex-col gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm leading-relaxed">
      <div className="font-semibold text-[var(--ink)]">{claim}</div>
      {stuck > 0 && <DepthTrack total={Math.max(USUAL_DEPTH, stuck)} stuck={stuck} label={`追到第 ${stuck} 层卡住`} />}
      {issue && <div className="text-[var(--ink-2)]">{issue}</div>}
      {thought && (
        <div className="flex items-start gap-2">
          <UserRound className="mt-1 h-4 w-4 shrink-0 text-[var(--muted)]" role="img" aria-label="面试官怎么想" />
          <span className="rounded-lg rounded-tl-sm bg-[var(--inset)] px-2.5 py-1 text-[var(--ink-2)]">{thought}</span>
        </div>
      )}
      {alternative && (
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex h-5 w-4 shrink-0 items-center justify-center text-xs font-semibold text-[var(--subtle)]" role="img" aria-label="也可能是">?</span>
          <span className="rounded-lg rounded-tl-sm border border-dashed border-[var(--line-2)] px-2.5 py-1 text-[var(--muted)]">{alternative}</span>
        </div>
      )}
      {answer && <div className="mt-auto pt-0.5"><AnswerNote answer={answer} /></div>}
    </li>
  );
}
