/**
 * 设置里的「投递时保持屏幕常亮」（缺省开）：屏幕睡了托管浏览器几乎停摆，批量投递只在进行时让屏幕常亮。
 */
import { useState } from 'react';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import { useCareerQuery } from './useCareerData';

const KEEP_AWAKE_PATH = '/api/career/batch/keep-awake';
const enabledOf = (r: unknown) => !(r && typeof r === 'object' && (r as { enabled?: unknown }).enabled === false);

export function CareerKeepAwakeSwitch() {
  const { data, reload } = useCareerQuery(async () => enabledOf(await apiGetJson<unknown>(KEEP_AWAKE_PATH)), []);
  const [error, setError] = useState<string | null>(null);
  const on = data !== false;
  const toggle = () => {
    setError(null);
    void apiPostJson<unknown>(KEEP_AWAKE_PATH, { enabled: !on }).then(reload, (e: unknown) => {
      console.error('[career] 切换保持屏幕常亮 FAILED', e);
      setError('没切换成功，再点一次');
    });
  };
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="flex-1 text-sm font-medium text-[var(--ink)]">投递时保持屏幕常亮</p>
      {error && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}
      <button role="switch" type="button" aria-checked={on} aria-label="投递时保持屏幕常亮" onClick={toggle}
        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${on ? 'bg-[var(--primary)]' : 'bg-[var(--line-2)]'}`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}
