/**
 * 简历编辑页：顶部「内容 / 版式」两块，两块都是双栏——左边改，右边实时排版预览（所见即所得）。
 *  - 内容：分区与条目；版式：模板、分栏、字体、配色、页面（含过机筛）；
 *  - 撤销 / 重做（⌘Z / ⇧⌘Z，输入框里交给浏览器自己的撤销）、自动保存、缩放（默认整页可见）；
 *  - 导出走侧车（PDF / Word / 图片），PDF 与预览同一套模板。
 * 内容改动会回写到简历内容（助理读的那份），版式只存在工作台文档里。
 */
import { ArrowLeft, FolderOpen, Minus, Plus, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { Button, fileDirname, suggestToChat } from '@/components/career/CareerPrimitives';
import type { Job, ResumeMaster, ResumeTailored } from '@/components/career/types';
import { openExternal } from '@/utils/openExternal';

import { DesignPanel } from './DesignPanel';
import { buildResumeEntries } from './ResumeGallery';
import { SectionsPanel } from './SectionsPanel';
import { StudioPreview } from './StudioPreview';
import { useStudioDocument, type SaveState } from './useStudioDocument';

/** A4 = 595 × 842pt；预览区四周各留 24px。 */
const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const PREVIEW_PAD = 48;
const ZOOMS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
/** 左栏宽：窄窗口（聊天旁）收窄，但始终双栏。 */
const NARROW = 900;

const SAVE_LABEL: Record<SaveState, string> = { idle: '已同步', dirty: '有未保存的修改', saving: '保存中…', saved: '已自动保存', error: '保存失败' };

type Mode = 'content' | 'layout';
const MODES: Array<{ id: Mode; label: string }> = [{ id: 'content', label: '内容' }, { id: 'layout', label: '版式' }];

function useResumeTitle(resumeId: string): string {
  const [title, setTitle] = useState('简历');
  useEffect(() => {
    let cancelled = false;
    Promise.all([careerApi.resumes(), careerApi.jobs().catch(() => [] as Job[])]).then(([r, jobs]) => {
      if (cancelled) return;
      const entry = buildResumeEntries((r.masters ?? []) as ResumeMaster[], (r.tailored ?? []) as ResumeTailored[], jobs).find(e => e.id === resumeId);
      if (entry) setTitle(entry.kind === 'master' ? `主简历 · ${entry.title}` : `岗位版 · ${entry.title}`);
    }).catch(() => { /* 标题拿不到就叫「简历」 */ });
    return () => { cancelled = true; };
  }, [resumeId]);
  return title;
}

/** 回调式 ref：元素在加载完成后才出现，也能量到尺寸。 */
function useSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

/** 默认缩放：一整页 A4 在预览区里完整可见（宽、高都放得下取较小的那个）。 */
export function fitPageZoom(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0.9;
  const z = Math.min((width - PREVIEW_PAD) / A4_WIDTH, (height - PREVIEW_PAD) / A4_HEIGHT);
  return Math.min(1.5, Math.max(0.3, z));
}

export function ResumeWorkbench({ resumeId, onBack }: { resumeId: string; onBack?: () => void }) {
  return <WorkbenchBody key={resumeId} resumeId={resumeId} onBack={onBack} />;
}

function WorkbenchBody({ resumeId, onBack }: { resumeId: string; onBack?: () => void }) {
  const doc = useStudioDocument(resumeId);
  const title = useResumeTitle(resumeId);
  const [mode, setMode] = useState<Mode>('content');
  // null = 适应预览区宽度
  const [zoom, setZoom] = useState<number | null>(null);
  const [rootRef, { width }] = useSize();
  const [previewRef, previewSize] = useSize();
  const [exporting, setExporting] = useState<string | null>(null);
  const [exported, setExported] = useState<{ format: string; path: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const fitZoom = fitPageZoom(previewSize.width, previewSize.height);
  const effectiveZoom = zoom ?? fitZoom;

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

  const zoomStep = (d: 1 | -1) => setZoom(() => {
    const z = effectiveZoom;
    const i = ZOOMS.findIndex(x => x >= z - 0.001);
    return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + d))];
  });
  const back = onBack ? () => { void doc.flush().then(onBack); } : undefined;

  if (doc.error && !doc.data) return <div role="alert" className="p-6 text-sm text-[var(--danger)]">打开简历失败：{doc.error}</div>;
  if (doc.loading || !doc.data) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开简历…</div>;
  const data = doc.data;
  const narrow = width > 0 && width < NARROW;
  // 顶栏保持一行：窄时「让助理改」只留图标
  const narrowBar = width > 0 && width < 1080;
  // 聊天旁的侧栏里：标题由侧栏头给出，对话就在旁边，缩放只留「整页」
  const compact = width > 0 && width < 800;

  return (
    <div ref={rootRef} data-testid="resume-workbench" className="flex h-full min-h-0 flex-col">
      {/* 顶栏：返回 / 标题 / 内容·版式 / 撤销 / 缩放 / 导出 */}
      <div className="flex items-center gap-x-3 border-b border-[var(--line)] px-4 py-2">
        {back && <Button variant="ghost" size="sm" className="-ml-2" onClick={back}><ArrowLeft className="h-4 w-4" />全部简历</Button>}
        {width >= 960 && <span className="min-w-0 max-w-[260px] shrink truncate font-human text-base font-semibold text-[var(--ink)]" title={title}>{title}</span>}
        <div role="tablist" aria-label="编辑内容或版式" className="inline-flex shrink-0 rounded-full border border-[var(--line-2)] p-0.5">
          {MODES.map(m => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}
              className={`h-7 rounded-full px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${mode === m.id ? 'bg-[var(--ink)] font-medium text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}>
              {m.label}
            </button>
          ))}
        </div>
        <span data-testid="studio-save-state" className={`shrink-0 whitespace-nowrap text-xs ${doc.saveState === 'error' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`} title={doc.saveError ?? undefined}>{SAVE_LABEL[doc.saveState]}</span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="sm" aria-label="撤销" title="撤销（⌘Z）" disabled={!doc.canUndo} onClick={doc.undo}><Undo2 className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" aria-label="重做" title="重做（⇧⌘Z）" disabled={!doc.canRedo} onClick={doc.redo}><Redo2 className="h-4 w-4" /></Button>
          <span className="mx-1 h-4 w-px bg-[var(--line)]" />
          {!compact && <Button variant="ghost" size="sm" aria-label="缩小" onClick={() => zoomStep(-1)}><Minus className="h-4 w-4" /></Button>}
          <button type="button" title="整页显示" onClick={() => setZoom(null)} className="w-11 rounded-md text-center text-xs tabular-nums text-[var(--muted)] hover:text-[var(--ink)]">{Math.round(effectiveZoom * 100)}%</button>
          {!compact && <Button variant="ghost" size="sm" aria-label="放大" onClick={() => zoomStep(1)}><Plus className="h-4 w-4" /></Button>}
          <span className="mx-1 h-4 w-px bg-[var(--line)]" />
          {!compact && <Button variant="ghost" size="sm" title="让助理按岗位或你的要求改这份简历" onClick={() => suggestToChat(`帮我看看这份简历哪里可以改得更好（${title}）`)}><Sparkles className="h-4 w-4" /><span className={narrowBar ? 'sr-only' : ''}>让助理改</span></Button>}
          <Button variant="primary" size="sm" busy={exporting === 'pdf'} disabled={exporting !== null} onClick={() => void doExport('pdf')}>导出 PDF</Button>
          <Button variant="ghost" size="sm" busy={exporting === 'docx'} disabled={exporting !== null} onClick={() => void doExport('docx')}>Word</Button>
          <Button variant="ghost" size="sm" busy={exporting === 'png'} disabled={exporting !== null} onClick={() => void doExport('png')}>图片</Button>
        </div>
      </div>
      {(exported || exportError) && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-1.5 text-xs">
          {exportError
            ? <span role="alert" className="text-[var(--danger)]">导出失败：{exportError}</span>
            : <><span className="truncate text-[var(--muted)]">已导出：{exported!.path}</span><Button variant="ghost" size="sm" onClick={() => void openExternal(fileDirname(exported!.path))}><FolderOpen className="h-4 w-4" />打开文件夹</Button></>}
        </div>
      )}

      {/* 两块都是双栏：左边改，右边即时渲染 */}
      <div className={`grid min-h-0 flex-1 ${narrow ? 'grid-cols-[minmax(260px,320px)_minmax(0,1fr)]' : 'grid-cols-[minmax(340px,420px)_minmax(0,1fr)]'}`}>
        <div role="tabpanel" aria-label={mode === 'content' ? '内容' : '版式'} className="min-h-0 overflow-y-auto border-r border-[var(--line)]">
          {mode === 'content'
            ? <div className="p-4"><SectionsPanel data={data} update={doc.update} /></div>
            : <DesignPanel data={data} update={doc.update} resumeId={resumeId} />}
        </div>
        <div ref={previewRef} className="min-h-0 overflow-auto bg-[var(--inset)]">
          <StudioPreview data={data} preview={doc.preview} zoom={effectiveZoom} />
        </div>
      </div>
    </div>
  );
}
