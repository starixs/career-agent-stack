/**
 * 过了时间的笔试 / 测评 / 面试：问一句「考了吗」，两个按钮一键答。答完服务端记进卷宗，这件事从月历、通知中心、今日队列里收起。
 * 问句由服务端给（core.asksAttendance / ATTENDANCE_QUESTION），这里只管按钮上的字。
 */
import { careerApi } from './careerApi';
import { Button } from './CareerPrimitives';
import type { DeadlineKind } from './types';
import { useCareerAction } from './useCareerData';

const ANSWERS: Partial<Record<DeadlineKind, readonly [yes: string, no: string]>> = {
  written_test: ['考了', '没去'],
  assessment: ['做了', '没做'],
  interview: ['去了', '没去'],
};
const FALLBACK: readonly [string, string] = ['参加了', '没参加'];

/** onAnswered 收到的是划掉这一行时显示的说明（「已参加」/「没参加」）。 */
export function AttendanceButtons({ deadlineId, kind, onAnswered }: { deadlineId: string; kind: DeadlineKind; onAnswered: (note: string) => void }) {
  const act = useCareerAction();
  const [yes, no] = ANSWERS[kind] ?? FALLBACK;
  const answer = (attended: boolean) => act.run(async () => {
    await careerApi.answerAttendance(deadlineId, attended);
    onAnswered(attended ? '已参加' : '没参加');
  });
  return (
    <>
      <Button variant="primary" size="sm" busy={act.busy} onClick={() => void answer(true)}>{yes}</Button>
      <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void answer(false)}>{no}</Button>
      {act.error && <span role="alert" className="text-xs text-[var(--danger)]">{act.error}</span>}
    </>
  );
}
