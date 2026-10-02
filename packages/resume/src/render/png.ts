/**
 * PNG 渲染：pdfjs-dist（legacy 构建）+ @napi-rs/canvas，把 PDF 某一页画成 PNG（短平台投递用）。
 */
import { createRequire } from 'node:module'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
let workerReady = false
function ensureWorker() {
  if (workerReady) return
  try { pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs') } catch { /* 退回 fake worker */ }
  workerReady = true
}

export interface RenderPngOptions { page?: number; scale?: number; background?: string }

export async function loadPdf(pdf: Buffer | Uint8Array) {
  ensureWorker()
  // pdfjs 会把 ArrayBuffer 转移给 worker（detach），所以必须拷贝一份，调用方的 Buffer 才能复用。
  const data = Uint8Array.from(pdf)
  return pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]).promise
}

/** PDF 页数（真实解析）。 */
export async function pdfPageCount(pdf: Buffer): Promise<number> {
  const doc = await loadPdf(pdf)
  try { return doc.numPages } finally { await doc.destroy() }
}

/** 抽取某页文本（测试与校验用）。 */
export async function pdfPageText(pdf: Buffer, page = 1): Promise<string> {
  const doc = await loadPdf(pdf)
  try {
    const p = await doc.getPage(page)
    const tc = await p.getTextContent()
    return tc.items.map(it => ('str' in it ? it.str : '')).join('')
  } finally { await doc.destroy() }
}

export async function renderPng(pdf: Buffer, opts: RenderPngOptions = {}): Promise<Buffer> {
  const pageNo = opts.page ?? 1
  const scale = opts.scale ?? 2
  const doc = await loadPdf(pdf)
  try {
    if (pageNo < 1 || pageNo > doc.numPages) throw new Error(`页码超出范围：${pageNo}（共 ${doc.numPages} 页）`)
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = opts.background ?? '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise
    return canvas.toBuffer('image/png')
  } finally { await doc.destroy() }
}
