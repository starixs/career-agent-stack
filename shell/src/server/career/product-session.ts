/**
 * 唯一的个人助理会话 id（渲染层启动时写进 config）。Global 后台（批量投递、邮件导入）往对话里放东西都靠它。
 * 单独一个小模块：推卡片的地方只要这个 id，不用把批量投递那套依赖一起拉进来。
 */
import { loadConfig } from '../utils/admin-config';

export function careerProductSessionId(): string | undefined {
  try { const id = loadConfig().careerSessionId; return typeof id === 'string' && id.trim() && !id.startsWith('pending-') ? id.trim() : undefined; } catch { return undefined; }
}
