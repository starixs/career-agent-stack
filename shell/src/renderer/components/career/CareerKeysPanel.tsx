/**
 * 求职助理的模型 / 搜索 Key 配置：设置页「通用」和对话里的配置卡片共用。
 *  - 模型 Key（必需）存到内置 provider `career-llm` 的 providerApiKeys，侧车 resolveProviderEnv 优先读它；
 *  - 搜索 Key（建议）存到 providerApiKeys['career-search'] + careerSearchProvider，search.ts 优先读它；
 *  - 启动时用环境变量注入的仍然有效（兜底），这里会显示"来自启动环境"。
 * Key 只写本机 config.json，不经过模型。
 */
import { useCallback, useEffect, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { useConfig } from '@/hooks/useConfig';

import {
  CAREER_LLM_PROVIDER_ID, CAREER_SEARCH_KEY_ID, CAREER_SEARCH_PROVIDERS, type CareerSearchProviderName,
} from '../../../shared/career-build-constants';
import { careerApi } from './careerApi';
import { Badge, Button, Select, TextInput } from './CareerPrimitives';
import type { CareerSetupStatus } from './types';

export const SETUP_CHANGED_EVENT = 'career:setup-changed';

const SEARCH_LABELS: Record<CareerSearchProviderName, { label: string; help: string }> = {
  bocha: { label: '博查（国内推荐）', help: 'open.bochaai.com 注册后在「API KEY 管理」创建' },
  tavily: { label: 'Tavily', help: 'tavily.com 注册后在 Dashboard 复制 API Key' },
  serper: { label: 'Serper（Google）', help: 'serper.dev 注册后在 Dashboard 复制 API Key' },
};

/** 读配置状态；Key 保存后（本组件或别处）自动刷新。 */
export function useCareerSetupStatus(): { status: CareerSetupStatus | null; reload: () => void } {
  const [status, setStatus] = useState<CareerSetupStatus | null>(null);
  const reload = useCallback(() => {
    // Promise.resolve 包一层：调用本身同步抛错（如接口未就绪）也走 catch，不打断渲染
    Promise.resolve().then(() => careerApi.setupStatus()).then(s => { if (s) setStatus(s); }).catch(() => { /* Global 未就绪：保持未知 */ });
  }, []);
  useEffect(() => { reload(); return onEvent(SETUP_CHANGED_EVENT, reload); }, [reload]);
  return { status, reload };
}

const mask = (key: string | undefined) => (key ? `${key.slice(0, 3)}****${key.slice(-4)}` : '');

export function CareerKeysPanel({ show = 'all', onSaved }: { show?: 'all' | 'llm' | 'search'; onSaved?: (what: 'llm' | 'search') => void }) {
  const { apiKeys, config, saveApiKey, updateConfig } = useConfig();
  const { status } = useCareerSetupStatus();
  const [llmKey, setLlmKey] = useState('');
  const [searchKey, setSearchKey] = useState('');
  const savedProvider = (config as { careerSearchProvider?: CareerSearchProviderName }).careerSearchProvider;
  const [provider, setProvider] = useState<CareerSearchProviderName>(savedProvider ?? 'bocha');
  const [busy, setBusy] = useState<'llm' | 'search' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async (what: 'llm' | 'search') => {
    setBusy(what); setError(null); setNotice(null);
    try {
      if (what === 'llm') {
        await saveApiKey(CAREER_LLM_PROVIDER_ID, llmKey.trim());
        setLlmKey('');
      } else {
        await updateConfig({ careerSearchProvider: provider } as Parameters<typeof updateConfig>[0]);
        await saveApiKey(CAREER_SEARCH_KEY_ID, searchKey.trim());
        setSearchKey('');
      }
      setNotice(what === 'llm' ? '模型 Key 已保存，下一条消息起生效' : '搜索 Key 已保存，立即生效');
      emitEvent(SETUP_CHANGED_EVENT, { what });
      onSaved?.(what);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const llmSaved = apiKeys[CAREER_LLM_PROVIDER_ID];
  const searchSaved = apiKeys[CAREER_SEARCH_KEY_ID];
  const sourceBadge = (s: CareerSetupStatus['llm'] | undefined, saved: string | undefined) => {
    if (saved) return <Badge tone="success">已保存 {mask(saved)}</Badge>;
    if (s?.source === 'build') return <Badge tone="info">来自启动环境</Badge>;
    if (s && !s.configured) return <Badge tone="warning">未配置</Badge>;
    return null;
  };

  return (
    <div data-testid="career-keys-panel" className="space-y-4">
      {show !== 'search' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
            模型 API Key <span className="text-xs font-normal text-[var(--muted)]">必需 · DeepSeek</span>
            {sourceBadge(status?.llm, llmSaved)}
          </div>
          <div className="flex gap-2">
            <TextInput aria-label="模型 API Key" type="password" autoComplete="new-password" placeholder={llmSaved ? '输入新 Key 替换' : 'sk-...'} value={llmKey} onChange={e => setLlmKey(e.target.value)} />
            <Button variant="primary" busy={busy === 'llm'} disabled={!llmKey.trim() || busy !== null} onClick={() => void save('llm')}>保存</Button>
          </div>
          <p className="text-xs text-[var(--subtle)]">在 platform.deepseek.com 的「API keys」创建。保存在本机配置里，助理对话和所有工具都用它，不用再在命令行注入。</p>
        </div>
      )}
      {show !== 'llm' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
            搜索 API Key <span className="text-xs font-normal text-[var(--muted)]">建议配置</span>
            {sourceBadge(status?.search, searchSaved)}
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="w-44">
              <Select
                ariaLabel="搜索提供方"
                value={provider}
                options={CAREER_SEARCH_PROVIDERS.map(p => ({ value: p, label: SEARCH_LABELS[p].label }))}
                onChange={v => setProvider(v as CareerSearchProviderName)}
              />
            </div>
            <div className="min-w-0 flex-1"><TextInput aria-label="搜索 API Key" type="password" autoComplete="new-password" placeholder={searchSaved ? '输入新 Key 替换' : 'API Key'} value={searchKey} onChange={e => setSearchKey(e.target.value)} /></div>
            <Button variant="primary" busy={busy === 'search'} disabled={!searchKey.trim() || busy !== null} onClick={() => void save('search')}>保存</Button>
          </div>
          <p className="text-xs text-[var(--subtle)]">{SEARCH_LABELS[provider].help}。不配置也能用，但公司调研、岗位核实只能靠模型已有知识，可能过时。</p>
        </div>
      )}
      {error && <div role="alert" className="text-xs text-[var(--danger)]">{error}</div>}
      {notice && <div role="status" className="text-xs text-[var(--success)]">{notice}</div>}
    </div>
  );
}
