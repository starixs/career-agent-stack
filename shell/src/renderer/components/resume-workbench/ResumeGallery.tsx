/**
 * 简历汇总：打开「我的资料 › 简历」先看到已经做好的每一份（成品缩略图 + 投给谁 + 模板 + 更新时间），
 * 点开一份再进入编辑页（内容 / 版式）。
 */
import { MessageSquareText, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';

import { careerApi } from '@/components/career/careerApi';
import { Badge, Button, ErrorRow, LoadingRow, formatDate, suggestToChat } from '@/components/career/CareerPrimitives';
import type { Job, ResumeMaster, ResumeTailored } from '@/components/career/types';

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
  if (error) return <div className="px-6 py-6"><ErrorRow message={error} onRetry={reload} /></div>;
  if (!entries) return <div className="px-6 py-6"><LoadingRow text="正在整理你的简历…" /></div>;

  const masters = entries.filter(e => e.kind === 'master').length;
  const tailored = entries.length - masters;

  return (
    <div data-testid="resume-gallery" className="h-full overflow-auto px-6 py-6">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-human text-2xl font-semibold text-[var(--ink)]">
          {entries.length > 0 ? `${entries.length} 份简历` : '还没有简历'}
          {entries.length > 0 && <span className="text-[var(--muted)]">{`，主简历 ${masters} 份 · 岗位版 ${tailored} 份`}</span>}
        </p>
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
        <p className="max-w-xl text-sm text-[var(--muted)]">简历由小芽从你的经历生成：先在「经历」里讲清楚做过的事，再说「帮我生成主简历」。生成后每一份都会出现在这里，点开可以改内容、换版式。</p>
      )}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-8 gap-y-10">
        {entries.map(entry => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onOpen(entry.id)}
              aria-label={`打开简历：${entry.title}`}
              className="group block w-full text-left focus-visible:outline-none"
            >
              <ResumeThumb id={entry.id} />
              <div className="mt-3 flex items-center gap-2">
                <Badge tone={entry.kind === 'master' ? 'accent' : 'neutral'}>{entry.kind === 'master' ? '主简历' : '岗位版'}</Badge>
                {entry.kind === 'tailored' && !entry.confirmed && <Badge>待确认改动</Badge>}
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-[var(--ink)] group-hover:text-[var(--primary)]" title={entry.title}>{entry.title}</div>
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                <TemplateName id={entry.id} />{` · ${formatDate(entry.updatedAt)} 更新${entry.exported ? ' · 已导出' : ''}`}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 每份简历的工作台文档只取一次，缩略图和模板名共用。 */
const studioCache = new Map<string, Promise<{ data: ResumeData; preview: Record<string, string> }>>();
function loadStudio(id: string) {
  let p = studioCache.get(id);
  if (!p) {
    p = careerApi.getStudio(id).then(r => ({ data: r.data, preview: r.preview }));
    p.catch(() => studioCache.delete(id));
    studioCache.set(id, p);
  }
  return p;
}

function useStudioSnapshot(id: string) {
  const [snap, setSnap] = useState<{ data: ResumeData; preview: Record<string, string> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadStudio(id).then(s => { if (!cancelled) setSnap(s); }).catch(() => { /* 缩略图拿不到就留占位 */ });
    return () => { cancelled = true; };
  }, [id]);
  return snap;
}

function ResumeThumb({ id }: { id: string }) {
  const snap = useStudioSnapshot(id);
  return (
    <div className="aspect-[1/1.414] w-full overflow-hidden rounded-lg border-[1.5px] border-[var(--line-2)] bg-white transition-shadow group-hover:border-[var(--hard)] group-hover:shadow-hard-lg group-focus-visible:ring-2 group-focus-visible:ring-[var(--primary)]">
      {snap ? <StudioPreview data={snap.data} preview={snap.preview} zoom={1} thumbnail /> : <div className="h-full w-full animate-pulse bg-[var(--inset)]" />}
    </div>
  );
}

function TemplateName({ id }: { id: string }) {
  const snap = useStudioSnapshot(id);
  return <>{snap ? templateLabel(snap.data.metadata.template).split(' · ')[0] : '…'}</>;
}
