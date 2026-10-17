/**
 * 提交前的审阅清单：填后检查把"值没生效 / 必填为空 / 站点报错 / 附件没回显 / 待补 / 草稿"归一成行，
 * 必填与选填分组；需要看的排前面，没问题的默认收起。批准后产品替用户点提交。
 */
import { useState } from 'react';

import { Badge, type BadgeTone } from './CareerPrimitives';
import type { SubmitReviewRow, SubmitReviewStatus, SubmitReviewSummary } from './types';

const STATUS: Record<SubmitReviewStatus, { label: string; tone: BadgeTone }> = {
  ok: { label: '已填', tone: 'success' },
  empty: { label: '必填为空', tone: 'error' },
  empty_optional: { label: '选填留空', tone: 'neutral' },
  unverified: { label: '没核对上', tone: 'warning' },
  mismatch: { label: '没生效', tone: 'error' },
  needs_user: { label: '需要你填', tone: 'warning' },
  draft: { label: '草稿待确认', tone: 'warning' },
  site_error: { label: '网站提示', tone: 'error' },
  upload_unconfirmed: { label: '附件待确认', tone: 'warning' },
};
const SOURCE: Record<string, string> = { profile: '资料', answer_bank: '答案库', draft: 'AI 草稿' };

export function approvalLabel(by: string | null | undefined): string | null {
  return by === 'auto' ? 'auto 模式已批准' : by === 'learned' ? '自学习免确认' : null;
}

export function SubmitReviewList({ review }: { review: SubmitReviewSummary | null | undefined }) {
  const [showOk, setShowOk] = useState(false);
  if (!review) return <div className="text-xs text-[var(--warning)]">没有拿到填后检查结果，请在浏览器现场里看一遍再批准。</div>;
  // 选填留空不算要人看，和已填好的一起收起
  const attention = review.rows.filter(r => r.status !== 'ok' && r.status !== 'empty_optional');
  const ok = review.rows.filter(r => r.status === 'ok' || r.status === 'empty_optional');
  const group = (rows: SubmitReviewRow[], required: boolean) => rows.filter(r => r.required === required);
  return (
    <div className="mt-1.5 space-y-1.5 text-xs">
      <div className="text-[var(--muted)]">
        必填 {review.requiredFilled} / {review.requiredTotal} 已填好
        {review.attention > 0 ? <span className="ml-1 text-[var(--danger)]">· {review.attention} 项需要你看</span> : <span className="ml-1 text-[var(--success)]">· 检查全部通过</span>}
      </div>
      {attention.length > 0 && (
        <>
          <Rows title="必填" rows={group(attention, true)} />
          <Rows title="选填" rows={group(attention, false)} />
        </>
      )}
      {ok.length > 0 && (
        <button type="button" className="text-[var(--primary)] underline underline-offset-2" onClick={() => setShowOk(v => !v)}>
          {showOk ? '收起已填好的项' : `查看已填好的 ${ok.length} 项`}
        </button>
      )}
      {showOk && (
        <>
          <Rows title="必填" rows={group(ok, true)} />
          <Rows title="选填" rows={group(ok, false)} />
        </>
      )}
    </div>
  );
}

function Rows({ title, rows }: { title: string; rows: SubmitReviewRow[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="mb-0.5 text-[var(--subtle)]">{title}（{rows.length}）</div>
      <ul className="space-y-0.5">
        {rows.map((r, i) => (
          <li key={`${r.fieldId ?? r.label}-${i}`} className="flex flex-wrap items-baseline gap-1.5">
            <Badge tone={STATUS[r.status]?.tone ?? 'warning'}>{STATUS[r.status]?.label ?? '要你看'}</Badge>
            <span className="font-medium text-[var(--ink)]">{r.label}</span>
            {r.value && <span className="max-w-[28rem] truncate text-[var(--muted)]" title={r.value}>{r.value}</span>}
            {r.source && SOURCE[r.source] && <span className="text-[var(--subtle)]">· {SOURCE[r.source]}</span>}
            {r.reason && r.status !== 'ok' && <span className="text-[var(--muted)]">— {r.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
