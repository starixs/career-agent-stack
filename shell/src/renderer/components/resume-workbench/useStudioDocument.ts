/**
 * 简历工作台的文档状态：加载 → 编辑（不可变更新）→ 撤销 / 重做 → 防抖自动保存。
 *  - 500ms 内的连续编辑合并成一步撤销（打字不会一字一步）；历史最多 50 步；
 *  - 自动保存 800ms 防抖，整份文档 PUT；卸载 / 切换简历前立即落盘；
 *  - 助理（工具）改了内容时 career:data-changed 会带 resume_* 表：没有未保存修改就重新加载。
 * 一个实例只对应一份简历：调用方切换简历时用 key={resumeId} 重新挂载。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';

import { onEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';

const MERGE_MS = 500;
const HISTORY_LIMIT = 50;
const SAVE_DEBOUNCE_MS = 800;

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface StudioDocument {
  data: ResumeData | null;
  preview: Record<string, string>;
  loading: boolean;
  error: string | null;
  saveState: SaveState;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** 改文档：recipe 返回新对象（调用方负责不可变更新，常用 produce 风格的小工具在 studioEdit.ts）。 */
  update: (recipe: (draft: ResumeData) => ResumeData, opts?: { merge?: string }) => void;
  undo: () => void;
  redo: () => void;
  reload: () => void;
  flush: () => Promise<void>;
}

export function useStudioDocument(resumeId: string): StudioDocument {
  const [data, setData] = useState<ResumeData | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyLen, setHistoryLen] = useState({ past: 0, future: 0 });

  const past = useRef<ResumeData[]>([]);
  const future = useRef<ResumeData[]>([]);
  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  const current = useRef<ResumeData | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(resumeId);
  const [nonce, setNonce] = useState(0);

  const syncHistory = () => setHistoryLen({ past: past.current.length, future: future.current.length });

  const save = useCallback(async () => {
    const id = idRef.current;
    const doc = current.current;
    if (!id || !doc || !dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    try {
      const out = await careerApi.saveStudio(id, doc);
      setPreview(out.preview);
      setSaveError(null);
      setSaveState(dirty.current ? 'dirty' : 'saved');
    } catch (e) {
      dirty.current = true;
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveState('error');
    }
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    await save();
  }, [save]);

  // 加载（首次 / 助理改了内容后重新加载）
  useEffect(() => {
    idRef.current = resumeId;
    let cancelled = false;
    careerApi.getStudio(resumeId)
      .then(out => {
        if (cancelled) return;
        past.current = []; future.current = []; lastMerge.current = null;
        current.current = out.data; setData(out.data); setPreview(out.preview); setSaveState('idle'); setError(null);
        setHistoryLen({ past: 0, future: 0 });
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      // 切走前把未保存的修改落盘（用旧 id：save 读的是 idRef，先保存再切）
      if (dirty.current && current.current) { const doc = current.current; void careerApi.saveStudio(resumeId, doc).catch(() => {}); dirty.current = false; }
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    };
  }, [resumeId, nonce]);

  // 助理改了内容：没有未保存的修改就重新加载
  useEffect(() => onEvent<{ tables?: string[] }>('career:data-changed', p => {
    if (!p?.tables?.some(t => t === 'resume_master' || t === 'resume_tailored')) return;
    if (dirty.current || saveTimer.current) return;
    setNonce(n => n + 1);
  }), []);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void save(); }, SAVE_DEBOUNCE_MS);
  }, [save]);

  const update = useCallback((recipe: (draft: ResumeData) => ResumeData, opts: { merge?: string } = {}) => {
    const prev = current.current;
    if (!prev) return;
    const next = recipe(prev);
    if (next === prev) return;
    const now = Date.now();
    const merging = opts.merge && lastMerge.current?.key === opts.merge && now - lastMerge.current.at < MERGE_MS;
    if (!merging) {
      past.current = [...past.current, prev].slice(-HISTORY_LIMIT);
      future.current = [];
    }
    lastMerge.current = opts.merge ? { key: opts.merge, at: now } : null;
    current.current = next;
    setData(next);
    syncHistory();
    schedule();
  }, [schedule]);

  const undo = useCallback(() => {
    const prev = past.current.at(-1);
    if (!prev || !current.current) return;
    past.current = past.current.slice(0, -1);
    future.current = [current.current, ...future.current];
    lastMerge.current = null;
    current.current = prev; setData(prev); syncHistory(); schedule();
  }, [schedule]);

  const redo = useCallback(() => {
    const next = future.current[0];
    if (!next || !current.current) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, current.current];
    lastMerge.current = null;
    current.current = next; setData(next); syncHistory(); schedule();
  }, [schedule]);

  // 关窗 / 刷新前落盘
  useEffect(() => {
    const onUnload = () => { if (dirty.current && idRef.current && current.current) void careerApi.saveStudio(idRef.current, current.current); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  return {
    data, preview, loading, error, saveState, saveError,
    canUndo: historyLen.past > 0, canRedo: historyLen.future > 0,
    update, undo, redo, flush, reload: () => setNonce(n => n + 1),
  };
}
