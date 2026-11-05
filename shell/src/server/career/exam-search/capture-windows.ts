/**
 * Windows：用系统自带的框选截图（`ms-screenclip:`，和 Win+Shift+S 同一个界面），框完图进剪贴板，
 * 再从剪贴板读出来，用 .NET 的 System.Drawing 转 JPEG（长边超过上限才缩，另出一张缩略图）。
 *
 * 全部放在一段 PowerShell 里跑（-STA：读剪贴板要求单线程套间），退出码约定：
 *   0 = 截到了（两份 JPEG 已写好）；2 = 取消或超时；3 = 截图工具打不开。
 * 取消没有明确信号：框选界面（ScreenClippingHost / SnippingTool）出现过又关了、剪贴板却没变，就当取消；
 * 一直看不到这两个进程时只能等到超时。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CAPTURE_TIMEOUT_MS, MAX_IMAGE_SIDE, THUMB_SIDE, errorText, readCapture, type Capture, type RunFile } from './capture-common';

/** 脚本自己的等待上限，比外层命令超时短，好让脚本先体面地退出（退出码 2）。 */
const SCRIPT_WAIT_MS = CAPTURE_TIMEOUT_MS - 5_000;
/** 框选界面关掉以后再等这么久剪贴板（图片写进剪贴板比界面关闭稍晚）。 */
const CLOSE_GRACE_MS = 1_500;
/** 轮询剪贴板的间隔。 */
const POLL_MS = 250;
export const EXIT_CANCELLED = 2;
export const EXIT_TOOL_FAILED = 3;

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function windowsCaptureScript(full: string, thumb: string): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace ExamShot -Name Clip -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
function Save-Jpeg($img, [int]$max, [string]$path) {
  $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
  $w = [Math]::Max(1, [int]($img.Width * $scale)); $h = [Math]::Max(1, [int]($img.Height * $scale))
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
}
$before = [ExamShot.Clip]::GetClipboardSequenceNumber()
try { Start-Process 'ms-screenclip:' } catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${EXIT_TOOL_FAILED} }
$deadline = (Get-Date).AddMilliseconds(${SCRIPT_WAIT_MS})
$seen = $false; $goneAt = $null; $got = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds ${POLL_MS}
  if ([ExamShot.Clip]::GetClipboardSequenceNumber() -ne $before -and [System.Windows.Forms.Clipboard]::ContainsImage()) { $got = $true; break }
  $open = @(Get-Process -Name ScreenClippingHost, SnippingTool -ErrorAction SilentlyContinue).Count -gt 0
  if ($open) { $seen = $true; $goneAt = $null }
  elseif ($seen) {
    if ($null -eq $goneAt) { $goneAt = Get-Date }
    elseif (((Get-Date) - $goneAt).TotalMilliseconds -gt ${CLOSE_GRACE_MS}) { break }
  }
}
if (-not $got) { exit ${EXIT_CANCELLED} }
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { exit ${EXIT_CANCELLED} }
Save-Jpeg $img ${MAX_IMAGE_SIDE} ${psQuote(full)}
Save-Jpeg $img ${THUMB_SIDE} ${psQuote(thumb)}
$img.Dispose()
exit 0
`;
}

/** PowerShell 的 -EncodedCommand 要 UTF-16LE 的 base64：路径里有中文、空格、引号都不用再转义。 */
export const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

const exitCodeOf = (err: unknown): number | null =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number' ? err.code : null;

/** 在 dir 里框选截一张；取消或超时返回 null；截图工具打不开时报错（页面里 Ctrl+V 照样能用）。 */
export async function captureWindows(run: RunFile, dir: string): Promise<Capture | null> {
  const full = join(dir, 'shot.jpg');
  const thumb = join(dir, 'thumb.jpg');
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(windowsCaptureScript(full, thumb))];
  const failure = await run('powershell.exe', args, { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true }).then(() => null, (err: unknown) => err);
  const taken = await stat(full).then(() => true, () => false);
  if (taken) return readCapture(full, thumb);
  if (exitCodeOf(failure) === EXIT_TOOL_FAILED) {
    throw new Error(`打不开系统截图工具（${errorText(failure)}）；可以按 Win+Shift+S 截图后在笔试助力页按 Ctrl+V`);
  }
  console.log(`[exam-search] 这次没截（取消或超时）${failure ? `：${errorText(failure)}` : ''}`);
  return null;
}
