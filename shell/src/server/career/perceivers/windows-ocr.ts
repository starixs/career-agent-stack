/**
 * Windows 上的 OCR：系统自带的 Windows.Media.Ocr（WinRT），通过 Windows PowerShell 5.1 调用，零安装。
 * 输出和 macOS Vision 版同一格式（整图宽高 + 每行归一化坐标），由 AppleVisionOcrPerceiver 的换算复用。
 * 需要系统装有中文 OCR 语言包（中文版 Windows 默认有）；没有就退回用户语言，再没有就报错（外层熔断会跳过）。
 */
import { execFile } from 'child_process';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

export const WINDOWS_OCR_PS = String.raw`param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $lang = [Windows.Globalization.Language]::new('zh-Hans-CN')
  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) } else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { Write-Output '{"error":"no OCR language pack installed"}'; exit 2 }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $W = [double]$bitmap.PixelWidth; $H = [double]$bitmap.PixelHeight
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($w in $line.Words) { $r = $w.BoundingRect; if ($r.X -lt $minX) { $minX = $r.X }; if ($r.Y -lt $minY) { $minY = $r.Y }; if ($r.X + $r.Width -gt $maxX) { $maxX = $r.X + $r.Width }; if ($r.Y + $r.Height -gt $maxY) { $maxY = $r.Y + $r.Height } }
    if ($line.Words.Count -eq 0) { continue }
    [void]$lines.Add(@{ text = $line.Text; confidence = 0.9; x = $minX / $W; y = $minY / $H; w = ($maxX - $minX) / $W; h = ($maxY - $minY) / $H })
  }
  @{ width = [int]$W; height = [int]$H; lines = @($lines) } | ConvertTo-Json -Compress -Depth 4
} catch { Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress); exit 3 }
`;

interface OcrLine { text: string; confidence: number; x: number; y: number; w: number; h: number }
export interface WindowsOcrPayload { width?: number; height?: number; lines?: OcrLine[]; error?: string }

/** Windows OCR 会在中文字之间插空格（按"词"识别），去掉中日韩字符之间的空白，英文单词间的空格保留。 */
export function joinCjkSpacing(text: string): string {
  return text.replace(/(?<=[\u3000-\u303f\u3400-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u3400-\u9fff\uff00-\uffef])/g, '').trim();
}

/** 解析脚本输出：ConvertTo-Json 遇到单元素数组会输出对象，统一成数组；中文去空格。 */
export function parseWindowsOcrOutput(stdout: string): WindowsOcrPayload {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}';
  const raw = JSON.parse(line) as { width?: number; height?: number; lines?: OcrLine | OcrLine[]; error?: string };
  if (raw.error) return { error: raw.error };
  const lines = raw.lines == null ? [] : Array.isArray(raw.lines) ? raw.lines : [raw.lines];
  return { width: raw.width, height: raw.height, lines: lines.map(l => ({ ...l, text: joinCjkSpacing(String(l.text ?? '')) })) };
}

export function windowsOcrAvailable(): boolean { return process.platform === 'win32'; }

let scriptPath: string | null = null;
function ensureScript(): string {
  if (scriptPath && existsSync(scriptPath)) return scriptPath;
  const dir = join(process.env.CAREER_DATA_DIR || tmpdir(), 'bin');
  mkdirSync(dir, { recursive: true });
  scriptPath = join(dir, `career-ocr-${createHash('sha1').update(WINDOWS_OCR_PS).digest('hex').slice(0, 10)}.ps1`);
  // 带 BOM 的 UTF-8，Windows PowerShell 5.1 才不会把脚本当成本地代码页
  if (!existsSync(scriptPath)) writeFileSync(scriptPath, `\ufeff${WINDOWS_OCR_PS}`, 'utf8');
  return scriptPath;
}

/** 跑一次 OCR（给 AppleVisionOcrPerceiver 的 runImpl 用）。 */
export function runWindowsOcr(imagePath: string, timeoutMs = 30_000): Promise<WindowsOcrPayload> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-Path', imagePath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) { reject(error); return; }
      try { resolve(parseWindowsOcrOutput(stdout)); } catch (e) { reject(e); }
    });
  });
}
