/**
 * 简历汇总：打开「我的资料 › 简历」先看到已经做好的每一份（成品缩略图 + 投给谁 + 模板 + 更新时间），
 * 点开一份再进入编辑页（内容 / 版式）。
 */
import { MessageSquareText, Plus, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { Button, ErrorRow, LoadingRow, formatDate, suggestToChat } from '@/components/career/CareerPrimitives';
import { NO_RESUME_OPENER } from '@/components/career/ColdStartCards';
import { SAMPLE_RESUME } from '@/components/career/skills/samples/resume';
import { SampleFrame } from '@/components/career/skills/samples/SampleFrame';
import type { Job, ResumeMaster, ResumeTailored } from '@/components/career/types';
import { PICK_RESUME_EVENT } from '@/components/chat-input/hooks/useResumePickSend';

import { StudioPreview } from './StudioPreview';
import { templateLabel } from './templateCatalog';

/** 汇总页上的一份简历：主简历或某个岗位的定制版。 */
export interface ResumeEntry {
  id: string;
  kind: 'master' | 'tailored';
  title: string;
  /** 岗位版写「公司 · 岗位」，主简历写方向。 */
  target: string | null;
  confirmed: boolean;
  exported: boolean;
  updatedAt: string;
}

export function buildResumeEntries(masters: ResumeMaster[], tailored: ResumeTailored[], jobs: Job[]): ResumeEntry[] {
  const byJob = new Map(jobs.map(j => [j.id, j]));
  const masterName = new Map(masters.map(m => [m.id, m.name]));
  const entries: ResumeEntry[] = [
    ...masters.map(m => ({
      id: m.id, kind: 'master' as const, title: m.name || '主简历', target: m.direction,
      confirmed: true, exported: false, updatedAt: m.updated_at,
    })),
    ...tailored.map(t => {
      const job = t.job_id ? byJob.get(t.job_id) : undefined;
      return {
        id: t.id, kind: 'tailored' as const,
        title: job ? `${job.company_name ?? '未知公司'} · ${job.title}` : `基于「${masterName.get(t.master_id) ?? '主简历'}」的定制版`,
        target: masterName.get(t.master_id) ? `基于「${masterName.get(t.master_id)}」` : null,
        confirmed: Boolean(t.diff_confirmed_at), exported: Boolean(t.export_pdf), updatedAt: t.updated_at,
      };
    }),
  ];
  // 主简历在前，各自按更新时间倒序
  return entries.sort((a, b) => (a.kind === b.kind ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.kind === 'master' ? -1 : 1));
}

function useResumeEntries() {
  const [state, setState] = useState<{ entries: ResumeEntry[] | null; error: string | null }>({ entries: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([careerApi.resumes(), careerApi.jobs().catch(() => [] as Job[])])
      .then(([r, jobs]) => { if (!cancelled) setState({ entries: buildResumeEntries(r.masters ?? [], r.tailored ?? [], jobs), error: null }); })
      .catch(e => { if (!cancelled) setState({ entries: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [nonce]);
  return { ...state, reload: () => setNonce(n => n + 1) };
}

export function ResumeGallery({ onOpen }: { onOpen: (id: string) => void }) {
  const { entries, error, reload } = useResumeEntries();
  // 每次进入汇总页都重新取各份简历的工作台文档：刚在编辑页改过的版式要立刻反映在缩略图上。
  const [loadStudio] = useState(makeStudioLoader);
  if (error) return <div className="px-6 py-6"><ErrorRow message={error} onRetry={reload} /></div>;
  if (!entries) return <div className="px-6 py-6"><LoadingRow text="正在整理你的简历…" /></div>;

  const masters = entries.filter(e => e.kind === 'master').length;
  const tailored = entries.length - masters;

  return (
    <div data-testid="resume-gallery" className="h-full overflow-auto px-6 py-6">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-human text-lg font-semibold text-[var(--ink)]">简历</h1>
        <span className="text-xs tabular-nums text-[var(--muted)]">
          {entries.length > 0 ? `主简历 ${masters} 份 · 岗位版 ${tailored} 份` : '还没有简历'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {masters > 0 && (
            <Button variant="ghost" onClick={() => suggestToChat('帮我对着一个岗位改一版简历', { surface: 'material' }, 'prefill')}>
              <MessageSquareText className="h-4 w-4" />对着岗位改一版
            </Button>
          )}
          <Button onClick={() => suggestToChat('帮我生成主简历', { surface: 'material' })}><Plus className="h-4 w-4" />生成主简历</Button>
        </div>
      </div>

      {entries.length === 0 && (
        <div data-testid="resume-gallery-empty" className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => suggestToChat(NO_RESUME_OPENER)}><MessageSquareText className="h-4 w-4" />跟小芽聊聊做过的事</Button>
          <Button variant="secondary" onClick={() => emitEvent(PICK_RESUME_EVENT, null)}><Upload className="h-4 w-4" />上传一份</Button>
        </div>
      )}
      {entries.length === 0 && <SampleGallery />}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-8 gap-y-10">
        {entries.map(entry => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onOpen(entry.id)}
              aria-label={`打开简历：${entry.title}`}
              className="group block w-full text-left focus-visible:outline-none"
            >
              <ResumeThumb id={entry.id} load={loadStudio} />
              <div className="mt-3 text-xs text-[var(--muted)]">
                {entry.kind === 'master' ? '主简历' : '岗位版'}
                {entry.kind === 'tailored' && !entry.confirmed && <span className="text-[var(--warning)]"> · 待确认改动</span>}
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-[var(--ink)] group-hover:text-[var(--primary)]" title={entry.title}>{entry.title}</div>
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                <TemplateName id={entry.id} load={loadStudio} />{` · ${formatDate(entry.updatedAt)} 更新${entry.exported ? ' · 已导出' : ''}`}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 一份都还没有：用示例的一份主简历把做好之后的样子摆出来（缩略图用同一套模板渲染，点不开）。 */
function SampleGallery() {
  return (
    <div className="mt-8">
      <SampleFrame>
        <div className="w-[240px]">
          <div className="aspect-[1/1.414] w-full overflow-hidden rounded-lg border-[1.5px] border-[var(--line-2)] bg-white">
            <StudioPreview data={SAMPLE_RESUME} preview={{}} zoom={1} thumbnail />
          </div>
          <div className="mt-3 truncate text-sm font-semibold text-[var(--ink)]">主简历</div>
          <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{templateLabel(SAMPLE_RESUME.metadata.template).split(' · ')[0]}</div>
        </div>
      </SampleFrame>
    </div>
  );
}

type StudioSnapshot = { data: ResumeData; preview: Record<string, string> };
type StudioLoader = (id: string) => Promise<StudioSnapshot>;

/** 一次汇总页内，每份简历的工作台文档只取一次，缩略图和模板名共用。 */
function makeStudioLoader(): StudioLoader {
  const cache = new Map<string, Promise<StudioSnapshot>>();
  return id => {
    let p = cache.get(id);
    if (!p) {
      p = careerApi.getStudio(id).then(r => ({ data: r.data, preview: r.preview }));
      p.catch(() => cache.delete(id));
      cache.set(id, p);
    }
    return p;
  };
}

function useStudioSnapshot(id: string, load: StudioLoader) {
  const [snap, setSnap] = useState<StudioSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    load(id).then(s => { if (!cancelled) setSnap(s); }).catch(() => { /* 缩略图拿不到就留占位 */ });
    return () => { cancelled = true; };
  }, [id, load]);
  return snap;
}

function ResumeThumb({ id, load }: { id: string; load: StudioLoader }) {
  const snap = useStudioSnapshot(id, load);
  const preview = useMemo(() => (snap ? withPlaceholderFallback(snap.data, snap.preview) : {}), [snap]);
  return (
    <div className="aspect-[1/1.414] w-full overflow-hidden rounded-lg border-[1.5px] border-[var(--line-2)] bg-white transition-shadow group-hover:border-[var(--hard)] group-hover:shadow-hard-lg group-focus-visible:ring-2 group-focus-visible:ring-[var(--primary)]">
      {snap ? <StudioPreview data={snap.data} preview={preview} zoom={1} thumbnail /> : <div className="h-full w-full animate-pulse bg-[var(--inset)]" />}
    </div>
  );
}

const VAULT_PLACEHOLDER_RX = /\{\{vault:[^}]+\}\}/g;
const FIELD_FALLBACK: Record<string, string> = { name: '姓名', phone: '手机', email: '邮箱', wechat: '微信', idNumber: '证件号', address: '地址' };

/**
 * 缩略图里不露占位符：私密库里还没填（或写法不对、解不出来）的 {{vault:…}}，用字段的中文名顶上，
 * 解出来的明文仍以服务端给的 preview 为准。
 */
export function withPlaceholderFallback(data: unknown, preview: Record<string, string>): Record<string, string> {
  const found = JSON.stringify(data).match(VAULT_PLACEHOLDER_RX) ?? [];
  const missing = found.filter(k => !(k in preview));
  if (!missing.length) return preview;
  const out = { ...preview };
  for (const k of missing) {
    const field = /^\{\{vault:profile[.:]([A-Za-z]+)\}\}$/.exec(k)?.[1];
    out[k] = field ? (FIELD_FALLBACK[field] ?? '') : '';
  }
  return out;
}

function TemplateName({ id, load }: { id: string; load: StudioLoader }) {
  const snap = useStudioSnapshot(id, load);
  return <>{snap ? templateLabel(snap.data.metadata.template).split(' · ')[0] : '…'}</>;
}
