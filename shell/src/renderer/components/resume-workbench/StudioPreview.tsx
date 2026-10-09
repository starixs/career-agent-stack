/**
 * 工作台中间的实时预览：resume-studio 模板在本地用 react-pdf 生成 PDF → pdf.js 画到 canvas。
 *  - 改动 400ms 防抖后重渲染；新页画好之前保留旧页，不闪；
 *  - 字体走侧车缓存（渲染层 CSP 不能直连字体 CDN）；
 *  - 预览里的私密信息是明文（preview 映射），文档本身仍是占位符。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';

import { globalBaseUrl } from '@/components/career/useGlobalLive';

import { withPreviewValues } from './studioEdit';

const RENDER_DEBOUNCE_MS = 400;

let fontsReady: Promise<void> | null = null;
/** 一次性：把模板字体的 CDN 地址改写到侧车字体缓存。 */
function prepareFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const [{ setWebFontUrlRewriter }, base] = await Promise.all([import('@career/resume-studio/fonts'), globalBaseUrl()]);
      if (base) setWebFontUrlRewriter(url => `${base}/api/career/live/font?u=${encodeURIComponent(url)}`);
    })();
  }
  return fontsReady;
}

export async function renderStudioPdf(doc: ResumeData): Promise<Blob> {
  await prepareFonts();
  const { createResumePdfBlob } = await import('@career/resume-studio/browser');
  return createResumePdfBlob({ data: doc });
}

interface RenderedPage { width: number; height: number; url: string }

export function StudioPreview({ data, preview, zoom, onPages }: {
  data: ResumeData;
  preview: Record<string, string>;
  /** 1 = 100%（A4 宽约 595pt）。 */
  zoom: number;
  onPages?: (count: number) => void;
}) {
  const doc = useMemo(() => withPreviewValues(data, preview), [data, preview]);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    const gen = ++generation.current;
    const timer = setTimeout(() => {
      setBusy(true);
      void (async () => {
        try {
          const blob = await renderStudioPdf(doc);
          if (gen !== generation.current) return;
          await import('@/components/richdoc/pdfWorker');
          const { getDocument } = await import('pdfjs-dist');
          const pdf = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
          const out: RenderedPage[] = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            // 2 倍分辨率画到 canvas，缩放交给 CSS，缩放时不用重渲染
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width; canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            await page.render({ canvasContext: ctx, viewport, canvas }).promise;
            const pngBlob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
            if (pngBlob) out.push({ width: viewport.width / 2, height: viewport.height / 2, url: URL.createObjectURL(pngBlob) });
          }
          await pdf.destroy();
          if (gen !== generation.current) { out.forEach(p => URL.revokeObjectURL(p.url)); return; }
          urls.current.forEach(u => URL.revokeObjectURL(u));
          urls.current = out.map(p => p.url);
          setPages(out);
          setError(null);
          onPages?.(out.length);
        } catch (e) {
          if (gen === generation.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (gen === generation.current) setBusy(false);
        }
      })();
    }, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, onPages]);

  useEffect(() => () => { urls.current.forEach(u => URL.revokeObjectURL(u)); }, []);

  return (
    <div data-testid="studio-preview" className="relative flex flex-col items-center gap-4 py-6">
      {busy && <div className="absolute right-3 top-2 rounded bg-[var(--paper)] px-2 py-0.5 text-xs text-[var(--muted)] shadow-sm">更新预览…</div>}
      {error && <div role="alert" className="mx-4 rounded-md border border-[var(--danger)]/40 bg-[var(--paper)] px-3 py-2 text-xs text-[var(--danger)]">预览生成失败：{error}</div>}
      {!pages.length && !error && <div className="mt-24 text-sm text-[var(--muted)]">正在排版…（首次加载中文字体需要几秒）</div>}
      {pages.map((p, i) => (
        <img
          key={p.url}
          src={p.url}
          alt={`第 ${i + 1} 页`}
          draggable={false}
          className="select-none bg-white shadow-md"
          style={{ width: p.width * zoom, height: p.height * zoom }}
        />
      ))}
    </div>
  );
}
