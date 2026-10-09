/**
 * 网申答案库（R05 网申信息表的"问题 → 答案"部分；基本信息与网站账号在私密信息页的其他分区）。
 *
 *  - 固定：同一问题总是用这一条；停用：不再自动填，但保留历史；删除：彻底删掉。
 *  - 个人信息 / 自我认同类答案默认遮住，点"显示"才看到。
 *  - 证件号、密码、"是否使用 AI 作答"、反机器人题不会进答案库，每次由本人如实填写。
 */
import { Eye, EyeOff, Pin, PinOff, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { careerApi } from './careerApi';
import { Badge, Button, ErrorRow, LoadingRow, SectionTitle, formatDate } from './CareerPrimitives';
import type { AnswerBankEntry } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

const SOURCE_LABEL: Record<string, string> = { user: '你填的', learned: '接管时学到', page_edit: '提交前你在页面上改的', import: '导入' };
const SENSITIVE = new Set(['personal', 'self_id']);

export function AnswerBankPanel() {
  const [showArchived, setShowArchived] = useState(false);
  const query = useCareerQuery(() => careerApi.answerBank(true), ['answer_bank']);
  const data = query.data ? { ...query.data, answers: query.data.answers.filter(a => showArchived || a.status !== 'archived') } : undefined;
  return (
    <section>
      <SectionTitle extra={<Button variant="ghost" onClick={() => setShowArchived(v => !v)}>{showArchived ? '只看在用的' : '含已停用'}</Button>}>
        网申答案库（{data?.answers.length ?? 0}）
      </SectionTitle>
      <div className="mb-2 text-xs text-[var(--muted)]">
        填网申时按问题自动命中；你在页面上改过的答案会以你为准更新这里。证件号、密码、「是否使用 AI 作答」这类问题不会存，每次请本人如实填写。
        {data && data.pendingUpload > 0 && <span className="ml-1 text-[var(--subtle)]">（{data.pendingUpload} 条改动待同步到服务端，用于改进答案质量；个人信息只同步「有改动」，不带内容）</span>}
      </div>
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !data && <LoadingRow />}
      {data && data.answers.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有答案。填网申时需要你回答的问题，答过一次就会记在这里。</div>}
      <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
        {data?.answers.map(a => <AnswerRow key={a.id} answer={a} onChanged={query.reload} />)}
      </ul>
    </section>
  );
}

function AnswerRow({ answer, onChanged }: { answer: AnswerBankEntry; onChanged: () => void }) {
  const [reveal, setReveal] = useState(false);
  const act = useCareerAction();
  const masked = SENSITIVE.has(answer.sensitivity) && !reveal;
  const setStatus = (status: AnswerBankEntry['status']) => act.run(async () => { await careerApi.setAnswerStatus(answer.id, status); onChanged(); });
  const remove = () => act.run(async () => { await careerApi.deleteAnswer(answer.id); onChanged(); });
  const archived = answer.status === 'archived';
  return (
    <li className={`py-3 ${archived ? 'text-[var(--subtle)]' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-[var(--ink)]">{answer.question_text}</span>
        {answer.status === 'pinned' && <Badge tone="accent">总是用这条</Badge>}
        {archived && <Badge tone="neutral">已停用</Badge>}
        {SOURCE_LABEL[answer.source] && <span className="text-[var(--subtle)]">· {SOURCE_LABEL[answer.source]}</span>}
        {answer.use_count > 0 && <span className="text-[var(--subtle)]">· 用过 {answer.use_count} 次</span>}
        <span className="text-[var(--subtle)]">· {formatDate(answer.updated_at)}</span>
        <span className="flex-1" />
        {SENSITIVE.has(answer.sensitivity) && (
          <Button size="sm" variant="ghost" aria-label={reveal ? '隐藏' : '显示'} onClick={() => setReveal(v => !v)}>{reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{reveal ? '隐藏' : '显示'}</Button>
        )}
        {!archived && (answer.status === 'pinned'
          ? <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void setStatus('active')}><PinOff className="h-3.5 w-3.5" />取消固定</Button>
          : <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void setStatus('pinned')}><Pin className="h-3.5 w-3.5" />总是用这条</Button>)}
        {archived
          ? <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void setStatus('active')}><ArchiveRestore className="h-3.5 w-3.5" />恢复</Button>
          : <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void setStatus('archived')}><Archive className="h-3.5 w-3.5" />停用</Button>}
        <Button size="sm" variant="ghost" busy={act.busy} aria-label="删除" onClick={() => void remove()}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-[var(--ink)]">{masked ? '••••••' : answer.answer}</div>
      {act.error && <ErrorRow message={act.error} />}
    </li>
  );
}
