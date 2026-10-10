/**
 * 持久 profile 的启动前清理：上次 Chrome 没走正常关闭（App / 侧车被强杀、断电），
 * profile 里会留下 exit_type=Crashed，下次启动就在窗口里弹"Chrome 未正确关闭 / 恢复页面"，
 * 用户看到的是"浏览器崩溃了"。托管浏览器的页面由产品自己恢复，不需要 Chrome 的恢复提示：
 * 启动前把标记改回正常（另有 --hide-crash-restore-bubble 兜底）。读写失败一律忽略，不能挡住启动。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** 返回是否改动了标记（便于日志与测试）。 */
export function markProfileExitedCleanly(userDataDir: string): boolean {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  if (!existsSync(prefsPath)) return false;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as { profile?: Record<string, unknown> };
    const profile = prefs.profile ?? {};
    if (profile.exit_type === 'Normal' && profile.exited_cleanly !== false) return false;
    prefs.profile = { ...profile, exit_type: 'Normal', exited_cleanly: true };
    writeFileSync(prefsPath, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
