/**
 * 卡组里这件事的几封邮件：按动作 id 取整张预览；改了一封 / 存了到岗信息就用服务端返回的那份换掉；
 * 发出去的从列表里拿走。服务端是唯一的来源，这里不自己算 blockers。
 */
import { useCallback, useEffect, useState } from 'react';

import type { MailDraftView } from '../../../../shared/careerMailApply';
import { mailApplyApi } from './mailApplyApi';

interface DraftsState { drafts: MailDraftView[] | null; error: string | null }

/** 按 action_id 换掉列表里的那几封，顺序不变；列表外的不加进来。 */
export function mergeDrafts(list: readonly MailDraftView[], fresh: readonly MailDraftView[]): MailDraftView[] {
  const byId = new Map(fresh.map(d => [d.action_id, d]));
  return list.map(d => byId.get(d.action_id) ?? d);
}

export function useMailDrafts(actionIds: readonly string[]) {
  const key = actionIds.join(',');
  const [state, setState] = useState<DraftsState>({ drafts: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    mailApplyApi.drafts(key ? key.split(',') : [])
      .then(drafts => { if (!cancelled) setState({ drafts, error: null }); })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[career] mail-apply drafts load FAILED ids=', key, message);
        if (!cancelled) setState(s => ({ drafts: s.drafts, error: message }));
      });
    return () => { cancelled = true; };
  }, [key, tick]);
  const replace = useCallback((fresh: readonly MailDraftView[]) => {
    setState(s => (s.drafts ? { ...s, drafts: mergeDrafts(s.drafts, fresh) } : s));
  }, []);
  const remove = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    setState(s => (s.drafts ? { ...s, drafts: s.drafts.filter(d => !gone.has(d.action_id)) } : s));
  }, []);
  const reload = useCallback(() => setTick(t => t + 1), []);
  return { drafts: state.drafts, error: state.error, replace, remove, reload };
}
