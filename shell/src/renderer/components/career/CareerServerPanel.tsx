/**
 * 服务端（共享岗位库 + 答案改动回传）地址设置。契约见 docs/SERVER-API.md。
 * 令牌只写不读；不填地址时一切只在本机。
 */
import { useState } from 'react';

import { apiGetJson, apiPutJson } from '@/api/apiFetch';

import { careerPath } from './careerApi';
import { Badge, Button, ErrorRow, TextInput } from './CareerPrimitives';
import { useCareerAction, useCareerQuery } from './useCareerData';

interface ServerStatus { configured: boolean; base_url: string | null; has_token: boolean; pending_answer_events: number }

export function CareerServerPanel() {
  const query = useCareerQuery(() => apiGetJson<ServerStatus>(careerPath('/server-config')), ['kv', 'answer_bank']);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const act = useCareerAction();
  const status = query.data;
  const value = base ?? status?.base_url ?? '';
  const save = () => act.run(async () => {
    await apiPutJson(careerPath('/server-config'), { base_url: value.trim(), ...(token.trim() ? { token: token.trim() } : {}) });
    setToken(''); setBase(null); query.reload();
  });
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {status?.configured ? <Badge tone="success">已连接配置</Badge> : <Badge tone="neutral">未配置（只用本机数据）</Badge>}
        {status && status.pending_answer_events > 0 && <span className="text-[var(--muted)]">{status.pending_answer_events} 条答案改动待同步</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput aria-label="服务端地址" placeholder="https://api.example.com" value={value} onChange={e => setBase(e.target.value)} className="w-72" />
        <TextInput aria-label="服务端令牌" type="password" placeholder={status?.has_token ? '令牌已保存（留空不改）' : '令牌（可选）'} value={token} onChange={e => setToken(e.target.value)} className="w-56" />
        <Button variant="primary" busy={act.busy} onClick={() => void save()}>保存</Button>
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}
