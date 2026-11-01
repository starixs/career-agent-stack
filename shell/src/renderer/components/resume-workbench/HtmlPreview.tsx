/**
 * HTML 简历预览：同一份 HTML 放进 iframe（不给脚本权限，父页面直接操作它的 DOM），
 * 字体从侧车缓存取字节、用 FontFace 注入（渲染层 CSP 的 font-src 不放行 localhost），
 * 然后在真实排版上跑「排满一页」。导出时侧车在 Chrome 里用同一套 HTML 与算法再排一次。
 */
import { useEffect, useRef, useState } from 'react';

import type { ResumeData } from '@career/resume-studio/schema';
import { availableHeightPx, buildResumeHtml, fitOnePage, PAGE_SIZE_MM, requiredFonts, type FitScales, type FontRequirement } from '@career/resume-studio/html';

import { prepareFonts } from './studioFonts';

/** HTML 排版是毫秒级，防抖只为合并连续击键。 */
const RENDER_DEBOUNCE_MS = 150;
/** CSS px / mm（96dpi）。 */
const PX_PER_MM = 96 / 25.4;
const EMPTY_DOC = '<!doctype html><html><head></head><body></body></html>';

const fontBytes = new Map<string, Promise<ArrayBuffer>>();
const loadedFaces = new WeakMap<Document, Set<string>>();

function fetchFont(url: string): Promise<ArrayBuffer> {
  let p = fontBytes.get(url);
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`字体下载失败 ${r.status}：${url}`); return r.arrayBuffer(); });
    p.catch(() => fontBytes.delete(url));
    fontBytes.set(url, p);
  }
  return p;
}

async function injectFonts(win: Window & typeof globalThis, fonts: FontRequirement[]): Promise<void> {
  const doc = win.document;
  const done = loadedFaces.get(doc) ?? new Set<string>();
  loadedFaces.set(doc, done);
  await Promise.all(fonts.map(async f => {
    const key = `${f.family}|${f.weight}`;
    if (done.has(key)) return;
    done.add(key);
    try {
      const face = new win.FontFace(f.family, await fetchFont(f.url), { weight: f.weight });
      doc.fonts.add(await face.load());
    } catch (error) {
      done.delete(key);
      console.warn(`[resume-preview] font=unavailable family=${f.family} weight=${f.weight} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

/** 用新 HTML 替换 iframe 内容；保留同一个 document，已注入的字体不丢。 */
function swapDocument(doc: Document, html: string): void {
  const next = new DOMParser().parseFromString(html, 'text/html');
  doc.documentElement.lang = next.documentElement.lang;
  doc.head.innerHTML = next.head.innerHTML;
  doc.body.innerHTML = next.body.innerHTML;
  for (const { name, value } of Array.from(next.body.attributes)) doc.body.setAttribute(name, value);
}

function applyScales(doc: Document, s: FitScales): number {
  doc.documentElement.style.setProperty('--fs', String(s.font));
  doc.documentElement.style.setProperty('--sp', String(s.space));
  return doc.querySelector('.content')?.getBoundingClientRect().height ?? 0;
}

type Layout = { height: number; pages: number; pageHeightPx: number; marginTopPx: number };

async function layoutResume(iframe: HTMLIFrameElement, data: ResumeData): Promise<Layout | null> {
  const win = iframe.contentWindow as (Window & typeof globalThis) | null;
  const html = buildResumeHtml(data);
  if (!win || !html) return null;
  swapDocument(win.document, html);
  await injectFonts(win, requiredFonts(data));
  await win.document.fonts.ready;
  const size = PAGE_SIZE_MM[data.metadata.page.format === 'letter' ? 'letter' : 'a4'];
  const available = availableHeightPx(size.height, data.metadata.page.marginY);
  const scales = data.metadata.page.autoFit ? await fitOnePage(s => applyScales(win.document, s), available) : { font: 1, space: 1 };
  const contentHeight = applyScales(win.document, scales);
  const page = win.document.querySelector('.page');
  return {
    height: page?.getBoundingClientRect().height ?? contentHeight,
    pages: Math.max(1, Math.ceil(contentHeight / available - 0.001)),
    pageHeightPx: available,
    marginTopPx: (data.metadata.page.marginY * 4) / 3,
  };
}

export function HtmlPreview({ data, zoom, onPages, thumbnail = false }: {
  data: ResumeData;
  zoom: number;
  onPages?: (count: number) => void;
  thumbnail?: boolean;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const generation = useRef(0);
  const pageWidthPx = PAGE_SIZE_MM[data.metadata.page.format === 'letter' ? 'letter' : 'a4'].width * PX_PER_MM;

  useEffect(() => {
    const gen = ++generation.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await prepareFonts();
          const el = iframe.current;
          if (!el) return;
          const next = await layoutResume(el, data);
          if (gen !== generation.current || !next) return;
          setLayout(next); setError(null); onPages?.(next.pages);
        } catch (e) {
          if (gen === generation.current) setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [data, onPages]);

  useEffect(() => {
    if (!thumbnail || !box.current) return;
    const ro = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [thumbnail]);

  const scale = thumbnail ? (boxWidth || pageWidthPx) / pageWidthPx : zoom;
  const height = layout?.height ?? pageWidthPx * 1.414;
  const frame = (
    <iframe ref={iframe} title="简历预览" sandbox="allow-same-origin" srcDoc={EMPTY_DOC} scrolling="no"
      style={{ width: pageWidthPx, height, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: thumbnail ? 'none' : undefined, background: 'white' }} />
  );

  if (thumbnail) {
    return <div ref={box} className="relative w-full overflow-hidden bg-white" style={{ aspectRatio: '1 / 1.414' }} aria-busy={!layout}>{frame}</div>;
  }

  return (
    <div data-testid="studio-preview" className="relative flex flex-col items-center gap-4 py-6">
      {error && <div role="alert" className="mx-4 rounded-md border border-[var(--danger)]/40 bg-[var(--paper)] px-3 py-2 text-xs text-[var(--danger)]">预览生成失败：{error}</div>}
      <div className="relative overflow-hidden bg-white shadow-md" style={{ width: pageWidthPx * scale, height: height * scale }}>
        {frame}
        {layout && Array.from({ length: layout.pages - 1 }, (_, i) => (
          <div key={i} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--danger)]/60"
            style={{ top: (layout.marginTopPx + (i + 1) * layout.pageHeightPx) * scale }}>
            <span className="absolute right-1 top-0.5 text-[10px] text-[var(--danger)]">第 {i + 2} 页</span>
          </div>
        ))}
      </div>
      {layout && layout.pages > 1 && (
        <div className="text-xs text-[var(--muted)]">
          {data.metadata.page.autoFit ? `内容较多，缩到最小字号仍需 ${layout.pages} 页` : `共 ${layout.pages} 页`}
        </div>
      )}
    </div>
  );
}
