/**
 * 简历工作台（resume-studio 风格）：左栏内容编辑 / 中间实时排版预览 / 右栏模板与设计。
 *  - 宽屏三栏；窄（聊天旁抽屉）时变成「内容 / 预览 / 设计」三个标签页；
 *  - 撤销 / 重做（⌘Z / ⇧⌘Z，输入框里交给浏览器自己的撤销）、自动保存、缩放；
 *  - 导出走侧车（PDF / Word / 图片），PDF 与预览同一套模板。
 * 内容改动会回写到简历内容（助理读的那份），排版只存在工作台文档里。
 */
import { FolderOpen, Minus, Plus, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import CustomSelect from '@/components/CustomSelect';
import { careerApi } from '@/components/career/careerApi';
import { Button, fileDirname, suggestToChat } from '@/components/career/CareerPrimitives';
import type { Job, ResumeMaster, ResumeTailored } from '@/components/career/types';
import { openExternal } from '@/utils/openExternal';

import { DesignPanel } from './DesignPanel';
import { SectionsPanel } from './SectionsPanel';
import { StudioPreview } from './StudioPreview';
import { useStudioDocument, type SaveState } from './useStudioDocument';

const WIDE_MIN = 1100;
const ZOOMS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

const SAVE_LABEL: Record<SaveState, string> = { idle: '已同步', dirty: '有未保存的修改', saving: '保存中…', saved: '已自动保存', error: '保存失败' };

interface ResumeOption { id: string; label: string }

function useResumeOptions(): ResumeOption[] {
  const [options, setOptions] = useState<ResumeOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([careerApi.resumes(), careerApi.jobs().catch(() => [] as Job[])]).then(([r, jobs]) => {
      if (cancelled) return;
      const byJob = new Map(jobs.map(j => [j.id, j]));
      const masters = (r.masters ?? []) as ResumeMaster[];
      const tailored = (r.tailored ?? []) as ResumeTailored[];
      setOptions([
        ...masters.map(m => ({ id: m.id, label: `主简历 · ${m.name}` })),
        ...tailored.map(t => { const j = t.job_id ? byJob.get(t.job_id) : undefined; return { id: t.id, label: `岗位版 · ${j ? `${j.company_name ?? ''} ${j.title}`.trim() : t.id}` }; }),
      ]);
    }).catch(() => { /* 列表拿不到就只显示当前这份 */ });
    return () => { cancelled = true; };
  }, []);
  return options;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function ResumeWorkbench({ initialResumeId }: { initialResumeId?: string | null }) {
  const options = useResumeOptions();
  const [picked, setPicked] = useState<string | null>(initialResumeId ?? null);
  const resumeId = picked ?? options[0]?.id ?? null;
  if (!resumeId) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--muted)]">还没有简历。在对话里说「帮我生成主简历」，生成后会在这里打开。</div>;
  }
  return <WorkbenchBody key={resumeId} resumeId={resumeId} options={options} onPick={setPicked} />;
}

function WorkbenchBody({ resumeId, options, onPick }: { resumeId: string; options: ResumeOption[]; onPick: (id: string) => void }) {
  const doc = useStudioDocument(resumeId);
  const [zoom, setZoom] = useState(0.9);
  const [tab, setTab] = useState<'content' | 'preview' | 'design'>('content');
  const [rootRef, width] = useWidth();
  const wide = width >= WIDE_MIN;
  const [exporting, setExporting] = useState<string | null>(null);
  const [exported, setExported] = useState<{ format: string; path: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const label = options.find(o => o.id === resumeId)?.label ?? '简历';

  // ⌘Z / ⇧⌘Z：焦点在输入框时交给浏览器自己的撤销
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) doc.redo(); else doc.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc]);

  const doExport = useCallback(async (format: 'pdf' | 'docx' | 'png') => {
    setExporting(format); setExportError(null);
    try {
      await doc.flush();
      const r = await careerApi.exportResume(resumeId, format);
      if (typeof r.path === 'string' && r.path) setExported({ format, path: r.path });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  }, [doc, resumeId]);

  const zoomStep = (d: 1 | -1) => setZoom(z => { const i = ZOOMS.findIndex(x => x >= z - 0.001); const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 4 : i) + d))]; return next; });
  const onPages = useCallback(() => {}, []);

  const preview = useMemo(() => (doc.data ? (
    <div className="h-full overflow-auto bg-[var(--inset)]">
      <StudioPreview data={doc.data} preview={doc.preview} zoom={zoom} onPages={onPages} />
    </div>
  ) : null), [doc.data, doc.preview, zoom, onPages]);

  if (doc.error && !doc.data) return <div role="alert" className="p-6 text-sm text-[var(--danger)]">打开简历失败：{doc.error}</div>;
  if (doc.loading || !doc.data) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开简历…</div>;
  const data = doc.data;

  return (
    <div ref={rootRef} data-testid="resume-workbench" className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <div className="w-64 max-w-full">
          <CustomSelect ariaLabel="选择简历版本" value={resumeId} options={options.length ? options.map(o => ({ value: o.id, label: o.label })) : [{ value: resumeId, label }]} onChange={v => { void doc.flush().then(() => onPick(v)); }} />
        </div>
        <span data-testid="studio-save-state" className={`text-xs ${doc.saveState === 'error' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`} title={doc.saveError ?? undefined}>{SAVE_LABEL[doc.saveState]}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" aria-label="撤销" title="撤销（⌘Z）" disabled={!doc.canUndo} onClick={doc.undo}><Undo2 className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" aria-label="重做" title="重做（⇧⌘Z）" disabled={!doc.canRedo} onClick={doc.redo}><Redo2 className="h-3.5 w-3.5" /></Button>
          <span className="mx-1 h-4 w-px bg-[var(--line)]" />
          <Button variant="ghost" aria-label="缩小" onClick={() => zoomStep(-1)}><Minus className="h-3.5 w-3.5" /></Button>
          <span className="w-10 text-center text-xs tabular-nums text-[var(--muted)]">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" aria-label="放大" onClick={() => zoomStep(1)}><Plus className="h-3.5 w-3.5" /></Button>
          <span className="mx-1 h-4 w-px bg-[var(--line)]" />
          <Button variant="ghost" title="让助理按岗位或你的要求改这份简历" onClick={() => suggestToChat(`帮我看看这份简历哪里可以改得更好（${label}）`)}><Sparkles className="h-3.5 w-3.5" />让助理改</Button>
          <Button variant="primary" busy={exporting === 'pdf'} disabled={exporting !== null} onClick={() => void doExport('pdf')}>导出 PDF</Button>
          <Button busy={exporting === 'docx'} disabled={exporting !== null} onClick={() => void doExport('docx')}>Word</Button>
          <Button busy={exporting === 'png'} disabled={exporting !== null} onClick={() => void doExport('png')}>图片</Button>
        </div>
      </div>
      {(exported || exportError) && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--inset)] px-3 py-1.5 text-xs">
          {exportError
            ? <span role="alert" className="text-[var(--danger)]">导出失败：{exportError}</span>
            : <><span className="truncate text-[var(--muted)]">已导出：{exported!.path}</span><Button variant="ghost" onClick={() => void openExternal(fileDirname(exported!.path))}><FolderOpen className="h-3.5 w-3.5" />打开文件夹</Button></>}
        </div>
      )}

      {wide ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,400px)_minmax(0,1fr)_300px]">
          <div className="min-h-0 overflow-y-auto border-r border-[var(--line)] p-3"><SectionsPanel data={data} update={doc.update} /></div>
          <div className="min-h-0">{preview}</div>
          <div className="min-h-0 overflow-y-auto border-l border-[var(--line)]"><DesignPanel data={data} update={doc.update} /></div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label="工作台视图" className="flex gap-1 border-b border-[var(--line)] px-3">
            {([['content', '内容'], ['preview', '预览'], ['design', '模板与设计']] as const).map(([key, text]) => (
              <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-[var(--primary)] text-[var(--ink)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'}`}>{text}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'content' && <div className="p-3"><SectionsPanel data={data} update={doc.update} /></div>}
            {tab === 'preview' && preview}
            {tab === 'design' && <DesignPanel data={data} update={doc.update} />}
          </div>
        </div>
      )}
    </div>
  );
}
