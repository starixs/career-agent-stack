/** 对话内流程卡片的公共外壳与 card.data 解析小工具（CareerFlowCards 与按卡拆出的文件共用）。 */
import { useState, type ReactNode } from 'react';

import { Button } from './CareerPrimitives';
import type { CareerCard } from './types';

// ---------- 数据解析（card.data 来自服务端，逐项校验） ----------
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

export function CardShell({ testId, icon, title, badge, children, onDismiss }: { testId: string; icon: ReactNode; title: string; badge?: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">{title}</span>
            {badge}
          </div>
        </div>
        {onDismiss && <Button variant="ghost" onClick={onDismiss} aria-label="稍后再说">稍后</Button>}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** onDone：用户在卡片里做完了（completed）；onDismiss：稍后再说（dismissed，可重新打开）。 */
export interface CardProps { card: CareerCard; onDone: () => void; onDismiss: () => void }

/** 卡片里的一次提交：busy / error 状态，成功返回 true。 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

export const ErrorLine = ({ error }: { error: string | null }) => (error ? <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</div> : null);
export const PrivacyNote = () => <p className="mt-2 text-xs text-[var(--subtle)]">只存进本机私密库，填表时在本地替换，助理看不到原文。</p>;
