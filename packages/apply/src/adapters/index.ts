export * from './types.js'
import type { SiteAdapter } from './types.js'
import { generic } from './generic.js'
import { beisen } from './beisen.js'
import { moka } from './moka.js'
import { feishu } from './feishu.js'
import { nowcoder } from './nowcoder.js'
import { boss } from './boss.js'

export { generic, beisen, moka, feishu, nowcoder, boss }

/** 顺序即优先级；generic 永远最后兜底。 */
export const ADAPTERS: readonly SiteAdapter[] = [beisen, moka, feishu, nowcoder, boss, generic]

export function pickAdapter(url: string, adapters: readonly SiteAdapter[] = ADAPTERS): SiteAdapter {
  return adapters.find(a => a.id !== 'generic' && a.match(url)) ?? generic
}
