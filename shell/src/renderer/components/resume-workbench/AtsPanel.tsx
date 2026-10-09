/**
 * 过机筛开关（R04）：开了之后这份简历导出与投递都用单栏、无照片、标准分区标题的版本（工作台排版只影响预览与非过机筛导出）。
 * "检查能否被读出"：按当前设置导出 PDF，用机器抽文字对照内容，列出读不出 / 顺序被打乱 / 图标字体等问题。
 */
import { useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { Badge, Button, ErrorRow } from '@/components/career/CareerPrimitives';
import type { AtsReport } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

export function AtsPanel({ resumeId }: { resumeId: string }) {
  const query = useCareerQuery(() => careerApi.resumeAts(resumeId), ['kv']);
  const [report, setReport] = useState<AtsReport | null>(null);
  const act = useCareerAction();
  const enabled = query.data?.enabled === true;
  return (
    <div className="space-y-2 text-xs">
      <label className="flex items-center gap-2">
        <input type="checkbox" aria-label="过机筛模式" checked={enabled} disabled={act.busy || !query.data} onChange={e => void act.run(async () => { await careerApi.setResumeAts(resumeId, e.target.checked); setReport(null); query.reload(); })} />
        <span className="text-[var(--ink)]">过机筛模式</span>
        <span className="text-[var(--muted)]">导出和投递用单栏、无照片的标准版，网申系统更容易读对</span>
      </label>
      <Button size="sm" busy={act.busy} onClick={() => void act.run(async () => { setReport(await careerApi.atsCheck(resumeId)); })}>检查能否被机器读出</Button>
      {report && (
        <div className="rounded-md border border-[var(--line)] bg-[var(--inset)] px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5">
            <Badge tone={report.ok ? (report.issues.length ? 'warning' : 'success') : 'error'}>{report.ok ? (report.issues.length ? '基本能读对' : '能读对') : '读不对'}</Badge>
            <span className="text-[var(--muted)]">{report.score} 分 · {report.pages} 页 · 读出 {report.extracted_chars} / {report.expected_chars} 字</span>
          </div>
          {report.issues.length === 0 ? <div className="text-[var(--muted)]">没发现问题。</div> : (
            <ul className="space-y-0.5">{report.issues.map((i, k) => <li key={k} className={i.level === 'error' ? 'text-[var(--danger)]' : 'text-[var(--ink)]'}>{i.message}</li>)}</ul>
          )}
          {!enabled && !report.ok && <div className="mt-1 text-[var(--muted)]">建议打开上面的过机筛模式后再检查一次。</div>}
        </div>
      )}
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}
