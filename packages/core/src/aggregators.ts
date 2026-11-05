/**
 * 招聘信息聚合站：岗位从这些站爬来，链接却还指向它们自己的岗位页（不是公司官网的投递入口）。
 * 在这些页面上「填表」只会把导航栏、站点标语当成要填的格子（2026-11-05 上汽集团 → offerseek.ai）。
 * 只列确定不收简历的站；智联、前程无忧这类本身能投递的招聘平台不在内。
 */
export const AGGREGATOR_HOSTS: readonly string[] = ['offerseek.ai', 'mianlingai.com', 'givemeoc.com', 'qiuzhifangzhou.com']

export function aggregatorHostOf(url: string | null | undefined): string | null {
  if (!url) return null
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  return AGGREGATOR_HOSTS.find(h => host === h || host.endsWith(`.${h}`)) ?? null
}
