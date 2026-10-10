/**
 * Windows 上的托管窗口：Windows 不会把屏幕外的窗口夹回来，停到屏幕外就真的看不见；
 * 再把窗口改成"工具窗口"样式，任务栏和 Alt+Tab 里也不出现，用户不会注意到多了一个 Chrome。
 * 只碰托管 Chrome 的主进程（按 --user-data-dir 找），绝不碰用户自己的 Chrome。
 * 通过 PowerShell + user32 P/Invoke 完成，不引入原生依赖；任何失败只记日志。
 */
import { execFile } from 'child_process';

const TIMEOUT_MS = 8_000;

const runPs = (script: string) => new Promise<string>((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** PowerShell 单引号字符串转义。 */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 找托管 Chrome 主进程（带这个 profile、不是 --type= 子进程）的脚本。 */
export function findManagedChromePidScript(profileDir: string): string {
  return [
    `$dir = ${psQuote(profileDir)}`,
    "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe' OR Name='chromium.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=') -and $_.CommandLine.Contains($dir) -and -not $_.CommandLine.Contains('--type=') } |",
    '  Select-Object -First 1 -ExpandProperty ProcessId',
    'if ($p) { $p } else { 0 }',
  ].join('\n');
}

/** 把某进程所有可见顶层窗口改成工具窗口（去掉任务栏 / Alt+Tab 按钮）的脚本；输出改动的窗口数。 */
export function hideFromTaskbarScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
  return [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class KsWin {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);',
    '  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '}',
    '"@',
    `$target = ${pid}`,
    '$GWL_EXSTYLE = -20; $WS_EX_TOOLWINDOW = 0x80; $WS_EX_APPWINDOW = 0x40000',
    '$script:changed = 0',
    '$cb = [KsWin+EnumProc]{ param($h, $l)',
    '  $owner = [uint32]0; [void][KsWin]::GetWindowThreadProcessId($h, [ref]$owner)',
    '  if ($owner -eq $target -and [KsWin]::IsWindowVisible($h)) {',
    '    $style = [KsWin]::GetWindowLongPtr($h, $GWL_EXSTYLE).ToInt64()',
    '    $next = ($style -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)',
    // 样式改动要隐藏再显示（不激活）才会刷新任务栏
    '    if ($next -ne $style) { [void][KsWin]::ShowWindow($h, 0); [void][KsWin]::SetWindowLongPtr($h, $GWL_EXSTYLE, [IntPtr]$next); [void][KsWin]::ShowWindow($h, 4); $script:changed++ }',
    '  }',
    '  $true }',
    '[void][KsWin]::EnumWindows($cb, [IntPtr]::Zero)',
    '$script:changed',
  ].join('\n');
}

/** 找到托管 Chrome 并把它从任务栏去掉；返回改动的窗口数（找不到进程返回 0）。 */
export async function hideManagedChromeFromTaskbar(profileDir: string): Promise<number> {
  const pid = Number((await runPs(findManagedChromePidScript(profileDir))).trim()) || 0;
  if (!pid) return 0;
  return Number((await runPs(hideFromTaskbarScript(pid))).trim()) || 0;
}
