/**
 * macOS 自带的 Vision 框架 OCR（VNRecognizeTextRequest）做视觉层的"眼睛"：零安装、离线、中英文都认。
 *
 * 实现：一段 Swift 源码首次使用时用 swiftc 编译成 `CAREER_DATA_DIR/bin/career-ocr`（按源码 hash 缓存），
 * 编译失败则退回 `swift <源文件>` 解释执行（慢几秒）。Node 侧把截图写到临时文件，拿回归一化包围盒后
 * 换算成视口 CSS 像素（截图是设备像素，按 viewport.width / 图宽 缩放）。
 * 只认字：输入框 / 按钮的位置由 @career/apply 的 synthesizeInputsFromLabels / DomBoxPerceiver 补。
 */
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import type { Perceiver, Perception, PerceiveContext, UiElement } from '@career/apply';
import { careerDataDir } from '../db';

const execFileAsync = promisify(execFile);

export const APPLE_VISION_OCR_SWIFT = `import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("{\\"error\\":\\"cannot load image\\"}")
  exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
  print("{\\"error\\":\\"\\(error)\\"}")
  exit(3)
}
var lines: [[String: Any]] = []
for obs in request.results ?? [] {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  lines.append(["text": c.string, "confidence": Double(c.confidence), "x": b.origin.x, "y": 1 - b.origin.y - b.size.height, "w": b.size.width, "h": b.size.height])
}
let payload: [String: Any] = ["width": cg.width, "height": cg.height, "lines": lines]
let data = try! JSONSerialization.data(withJSONObject: payload)
print(String(data: data, encoding: .utf8)!)
`;

interface OcrLine { text: string; confidence: number; x: number; y: number; w: number; h: number }
interface OcrPayload { width?: number; height?: number; lines?: OcrLine[]; error?: string }

export interface AppleVisionOcrOptions {
  /** 编译产物与源码放哪（缺省 CAREER_DATA_DIR/bin）。 */
  binDir?: string;
  timeoutMs?: number;
  /** 测试注入：跳过 swift，直接返回结果。 */
  runImpl?: (imagePath: string) => Promise<OcrPayload>;
}

export function appleVisionAvailable(): boolean {
  return process.platform === 'darwin' && (existsSync('/usr/bin/swiftc') || existsSync('/usr/bin/swift'));
}

export class AppleVisionOcrPerceiver implements Perceiver {
  readonly id = 'apple-vision-ocr';
  private binary: Promise<string | null> | null = null;
  constructor(private readonly options: AppleVisionOcrOptions = {}) {}

  private get binDir(): string { return this.options.binDir ?? join(careerDataDir(), 'bin'); }

  /** 首次调用编译（按源码 hash 缓存）；失败返回 null（之后走 swift 解释执行）。 */
  private ensureBinary(): Promise<string | null> {
    if (!this.binary) {
      this.binary = (async () => {
        try {
          mkdirSync(this.binDir, { recursive: true });
          const hash = createHash('sha1').update(APPLE_VISION_OCR_SWIFT).digest('hex').slice(0, 10);
          const src = join(this.binDir, `career-ocr-${hash}.swift`);
          const bin = join(this.binDir, `career-ocr-${hash}`);
          if (!existsSync(src)) writeFileSync(src, APPLE_VISION_OCR_SWIFT);
          if (existsSync(bin)) return bin;
          await execFileAsync('/usr/bin/swiftc', ['-O', '-o', bin, src], { timeout: 120_000 });
          return existsSync(bin) ? bin : null;
        } catch (error) {
          console.warn('[career] Apple Vision OCR 编译失败，改用 swift 解释执行：', error instanceof Error ? error.message : error);
          return null;
        }
      })();
    }
    return this.binary;
  }

  private async run(imagePath: string): Promise<OcrPayload> {
    if (this.options.runImpl) return this.options.runImpl(imagePath);
    const timeout = this.options.timeoutMs ?? 30_000;
    const bin = await this.ensureBinary();
    const { stdout } = bin
      ? await execFileAsync(bin, [imagePath], { timeout, maxBuffer: 8 * 1024 * 1024 })
      : await execFileAsync('/usr/bin/swift', [join(this.binDir, `career-ocr-${createHash('sha1').update(APPLE_VISION_OCR_SWIFT).digest('hex').slice(0, 10)}.swift`), imagePath], { timeout: timeout * 3, maxBuffer: 8 * 1024 * 1024 });
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
    return JSON.parse(line) as OcrPayload;
  }

  async perceive(screenshot: Uint8Array, ctx: PerceiveContext): Promise<Perception> {
    const t0 = Date.now();
    const file = join(tmpdir(), `career-ocr-${process.pid}-${Date.now()}.jpg`);
    writeFileSync(file, screenshot);
    let payload: OcrPayload;
    try { payload = await this.run(file); } finally { try { unlinkSync(file); } catch { /* ignore */ } }
    if (payload.error) throw new Error(`OCR 失败：${payload.error}`);
    const imgW = payload.width || ctx.viewport.width;
    const imgH = payload.height || ctx.viewport.height;
    // 截图是设备像素；视口是 CSS 像素。按宽度比例换算（高度同理，截图可能是整页或视口）。
    const sx = ctx.viewport.width / imgW;
    const sy = sx;
    const elements: UiElement[] = (payload.lines ?? []).map((l, i): UiElement => ({
      id: `ocr:${i}`,
      kind: 'text',
      text: l.text.trim(),
      box: { x: Math.round(l.x * imgW * sx), y: Math.round(l.y * imgH * sy), w: Math.round(l.w * imgW * sx), h: Math.round(l.h * imgH * sy) },
      confidence: Math.max(0, Math.min(1, l.confidence)),
    })).filter(e => e.text);
    return { source: this.id, viewport: ctx.viewport, elements, tookMs: Date.now() - t0 };
  }
}
